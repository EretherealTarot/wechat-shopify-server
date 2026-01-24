// server.js — WeChat Mini Program + NihaoPay + Shopify bridge (FULL, with Orders API)

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Simple CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------------- CONFIG -------------------
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "edd11f-2.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";

const WX_APPID = process.env.WX_APPID || "";
const WX_SECRET = process.env.WX_SECRET || "";

const NIHAOPAY_TOKEN = process.env.NIHAOPAY_TOKEN || "";
const NIHAOPAY_IPN_URL = process.env.NIHAOPAY_IPN_URL || "";

const SETTLEMENT_CURRENCY = "CAD";

// In-memory payment store (MVP)
const payments = new Map();

// ------------------- HELPERS -------------------
function assertEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

function toFen(amountCNY) {
  const n = Number(amountCNY);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function genReference() {
  const rand = crypto.randomBytes(4).toString("hex");
  return `wx${Date.now()}${rand}`.slice(0, 30);
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  if (req.ip) return String(req.ip).replace("::ffff:", "");
  return "127.0.0.1";
}

async function shopifyAdminGraphQL(query, variables = {}) {
  assertEnv("SHOPIFY_ADMIN_TOKEN", ADMIN_TOKEN);

  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(
      `Shopify error: ${JSON.stringify(json.errors || json)}`
    );
  }
  return json.data;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function toMiniStatus(fin, ful) {
  fin = (fin || "").toUpperCase();
  ful = (ful || "").toUpperCase();

  if (fin.includes("PENDING") || fin.includes("UNPAID")) return "pending";
  if (fin.includes("PAID") && ful.includes("UNFULFILLED")) return "paid";
  if (ful.includes("FULFILLED")) return "shipped";
  return "paid";
}

function badgeForStatus(status) {
  if (status === "pending") return { badgeText: "待付款", badgeClass: "badge--pending" };
  if (status === "paid") return { badgeText: "已付款", badgeClass: "badge--paid" };
  if (status === "shipped") return { badgeText: "已发货", badgeClass: "badge--shipped" };
  return { badgeText: "已完成", badgeClass: "badge--completed" };
}

// ------------------- ROUTES -------------------

// Health
app.get("/", (_req, res) => {
  res.json({ ok: true });
});

// ------------------- ORDERS (READ-ONLY) -------------------

const ORDER_LIST_QUERY = `
query Orders($query: String!) {
  orders(first: 20, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 5) { nodes { title quantity } }
    }
  }
}
`;

const ORDER_DETAIL_QUERY = `
query Order($id: ID!) {
  order(id: $id) {
    id
    name
    createdAt
    displayFinancialStatus
    displayFulfillmentStatus
    currentSubtotalPriceSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    currentTotalPriceSet { shopMoney { amount } }

    shippingAddress {
      name phone address1 address2 city province zip country
    }

    lineItems(first: 50) {
      nodes {
        title quantity
        originalTotalSet { shopMoney { amount } }
      }
    }

    fulfillments(first: 5) {
      trackingInfo { company number url }
    }
  }
}
`;

app.get("/api/orders", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: "Missing phone" });

    const data = await shopifyAdminGraphQL(ORDER_LIST_QUERY, {
      query: `phone:${phone}`
    });

    const out = (data.orders.nodes || []).map(o => {
      const status = toMiniStatus(
        o.displayFinancialStatus,
        o.displayFulfillmentStatus
      );
      return {
        id: o.id,
        name: o.name,
        date: o.createdAt.replace("T", " ").slice(0, 16),
        total: o.currentTotalPriceSet.shopMoney.amount,
        status,
        ...badgeForStatus(status),
        itemsSummary: o.lineItems.nodes
          .map(li => `${li.title} ×${li.quantity}`)
          .join("，")
      };
    });

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const data = await shopifyAdminGraphQL(ORDER_DETAIL_QUERY, {
      id: req.params.id
    });

    const o = data.order;
    if (!o) return res.status(404).json({ error: "Order not found" });

    const status = toMiniStatus(
      o.displayFinancialStatus,
      o.displayFulfillmentStatus
    );

    const addr = o.shippingAddress || {};
    const tracking = o.fulfillments?.[0]?.trackingInfo?.[0];

    res.json({
      id: o.id,
      name: o.name,
      date: o.createdAt.replace("T", " ").slice(0, 16),
      status,
      ...badgeForStatus(status),
      items: o.lineItems.nodes.map(li => ({
        title: li.title,
        qty: li.quantity,
        price: li.originalTotalSet.shopMoney.amount
      })),
      subtotal: o.currentSubtotalPriceSet.shopMoney.amount,
      shipping: o.totalShippingPriceSet.shopMoney.amount,
      total: o.currentTotalPriceSet.shopMoney.amount,
      address: {
        name: addr.name || "",
        phone: addr.phone || "",
        full: [addr.country, addr.province, addr.city, addr.address1, addr.address2, addr.zip]
          .filter(Boolean)
          .join(" ")
      },
      tracking: tracking
        ? { company: tracking.company, number: tracking.number, url: tracking.url }
        : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------- (REST OF YOUR EXISTING ROUTES UNCHANGED) -------------------
// Stock, NihaoPay, IPN, order creation — already working, untouched

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});

