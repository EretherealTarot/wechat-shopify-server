// server.js — WeChat Mini Program + NihaoPay + Shopify bridge + Orders API + Shipping subscription message

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2
const crypto = require("crypto");

const app = express();

// IMPORTANT: need rawBody for Shopify webhook HMAC
app.use((req, res, next) => {
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    req.rawBody = data;
    next();
  });
});

app.use((req, res, next) => {
  if (req.method === "POST" || req.method === "PUT") {
    try {
      req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
    } catch (e) {
      req.body = {};
    }
  }
  next();
});

// Simple CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Shopify-Hmac-Sha256");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------------- CONFIG -------------------
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "edd11f-2.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";

const WX_APPID = process.env.WX_APPID || "";
const WX_SECRET = process.env.WX_SECRET || "";
const WX_SHIP_TEMPLATE_ID = process.env.WX_SHIP_TEMPLATE_ID || "";

const NIHAOPAY_TOKEN = process.env.NIHAOPAY_TOKEN || "";
const NIHAOPAY_IPN_URL = process.env.NIHAOPAY_IPN_URL || "";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://wechat-shopify-server.onrender.com";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

const SETTLEMENT_CURRENCY = "CAD";

// In-memory payment store (MVP)
const payments = new Map(); // paymentId -> { status, amountFen, items, address, remark, nihaoTxId, orderId, openid, createdAt }

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

async function shopifyAdminGraphQL(query, variables = {}) {
  assertEnv("SHOPIFY_ADMIN_TOKEN", ADMIN_TOKEN);

  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Shopify returned non-JSON. HTTP ${res.status}. Body: ${text}`);
  }

  if (!res.ok || (json.errors && json.errors.length)) {
    throw new Error(`Shopify error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

async function wechatCodeToOpenId(code) {
  assertEnv("WX_APPID", WX_APPID);
  assertEnv("WX_SECRET", WX_SECRET);

  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${encodeURIComponent(WX_APPID)}` +
    `&secret=${encodeURIComponent(WX_SECRET)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  const res = await fetch(url);
  const json = await res.json();

  if (!json || json.errcode) {
    throw new Error(`WeChat jscode2session error: ${JSON.stringify(json)}`);
  }
  if (!json.openid) {
    throw new Error(`WeChat missing openid: ${JSON.stringify(json)}`);
  }
  return json.openid;
}

// ---- Shopify Webhook HMAC verify ----
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody || "", "utf8")
    .digest("base64");

  return digest === hmacHeader;
}

// ---- WeChat Access Token cache ----
let wxTokenCache = { token: "", expiresAt: 0 };

async function getWeChatAccessToken() {
  assertEnv("WX_APPID", WX_APPID);
  assertEnv("WX_SECRET", WX_SECRET);

  const now = Date.now();
  if (wxTokenCache.token && wxTokenCache.expiresAt > now + 60_000) {
    return wxTokenCache.token;
  }

  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(WX_APPID)}` +
    `&secret=${encodeURIComponent(WX_SECRET)}`;

  const res = await fetch(url);
  const json = await res.json();

  if (!json || !json.access_token) {
    throw new Error(`WeChat token error: ${JSON.stringify(json)}`);
  }

  wxTokenCache.token = json.access_token;
  wxTokenCache.expiresAt = now + (Number(json.expires_in || 7200) * 1000);
  return wxTokenCache.token;
}

// ---- Send subscription message ----
// NOTE: Template “data keys” depend on WeChat template field IDs.
// If WeChat returns a data-format error, open template “详情” and you’ll see placeholders like {{thing1.DATA}}.
// Then we’ll map keys in WX_SHIP_DATA_KEYS env without changing code.
function buildShipTemplateData({
  logisticsCompany,
  trackingNumber,
  shipTime,
  orderName
}) {
  // Default fallback (often works for older keyword templates)
  // If your template uses thing1/date2/etc, we’ll swap keys after first real shipment.
  return {
    keyword1: { value: logisticsCompany || "PostNL" },
    keyword2: { value: trackingNumber || "暂无" },
    keyword3: { value: shipTime || "" },
    keyword4: { value: orderName || "" }
  };
}

async function sendWeChatShipMessage({ openid, orderGid, orderName, logisticsCompany, trackingNumber, shipTime }) {
  if (!WX_SHIP_TEMPLATE_ID) {
    console.log("[wx] WX_SHIP_TEMPLATE_ID missing; skip send");
    return { skipped: true, reason: "NO_TEMPLATE_ID" };
  }
  if (!openid) {
    console.log("[wx] openid missing; skip send");
    return { skipped: true, reason: "NO_OPENID" };
  }

  const token = await getWeChatAccessToken();

  const payload = {
    touser: openid,
    template_id: WX_SHIP_TEMPLATE_ID,
    page: `pages/orderDetail/orderDetail?id=${encodeURIComponent(orderGid)}`,
    data: buildShipTemplateData({ logisticsCompany, trackingNumber, shipTime, orderName })
  };

  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json = await res.json();
  console.log("[wx] send result:", json);

  // errcode === 0 success
  if (!json || json.errcode !== 0) {
    throw new Error(`WeChat send failed: ${JSON.stringify(json)}`);
  }

  return json;
}

// ------------------- NihaoPay micropay -------------------
async function nihaoMicropay({ amountFen, reference, openId, clientIp, description, note }) {
  assertEnv("NIHAOPAY_TOKEN", NIHAOPAY_TOKEN);
  assertEnv("NIHAOPAY_IPN_URL", NIHAOPAY_IPN_URL);
  assertEnv("WX_APPID", WX_APPID);

  const form = new URLSearchParams();

  form.set("currency", SETTLEMENT_CURRENCY);
  form.set("rmb_amount", String(amountFen));

  form.set("reference", reference);
  form.set("ipn_url", NIHAOPAY_IPN_URL);
  form.set("open_id", openId);
  form.set("client_ip", clientIp);
  form.set("app_id", WX_APPID);

  if (description) form.set("description", description);
  if (note) form.set("note", note);

  const res = await fetch("https://api.nihaopay.com/v1.2/transactions/micropay", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NIHAOPAY_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`NihaoPay non-JSON. HTTP ${res.status}. Body: ${text}`);
  }

  console.log("[nihao] response http:", res.status);
  console.log("[nihao] response body:", json);

  if (!res.ok) {
    throw new Error(`NihaoPay HTTP ${res.status}: ${text}`);
  }

  return json;
}

// ------------------- ROUTES -------------------

// Health
app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "wechat-shopify-server" });
});

// Stock lookup
app.get("/api/stock", async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) return res.status(400).json({ error: "Missing productId" });

    const query = `
      query getStock($id: ID!) {
        product(id: $id) { id totalInventory }
      }
    `;
    const data = await shopifyAdminGraphQL(query, { id: productId });
    const product = data.product;
    if (!product) return res.status(404).json({ error: "Product not found" });

    const qty = product.totalInventory ?? 0;
    return res.json({ productId, quantity: qty, available: qty > 0 });
  } catch (err) {
    console.error("GET /api/stock error", err);
    return res.status(500).json({ error: "Internal error", message: err?.message || String(err) });
  }
});

// PREPAY
app.post("/api/pay/prepay", async (req, res) => {
  try {
    const { wxCode, amountCNY, items, address, remark } = req.body || {};
    if (!wxCode) return res.status(400).json({ error: "Missing wxCode" });

    const amountFen = toFen(amountCNY);
    if (!amountFen) return res.status(400).json({ error: "Invalid amountCNY" });

    const openid = await wechatCodeToOpenId(wxCode);

    const clientIp = getClientIp(req);
    const paymentId = genReference();

    payments.set(paymentId, {
      status: "pending",
      amountFen,
      items: items || [],
      address: address || null,
      remark: remark || "",
      nihaoTxId: null,
      orderId: null,
      openid,
      createdAt: Date.now()
    });

    const np = await nihaoMicropay({
      amountFen,
      reference: paymentId,
      openId: openid,
      clientIp,
      description: "Erethereal WeChat Mini Program",
      note: remark || "WeChat Mini Program"
    });

    return res.json({
      paymentId,
      timeStamp: np.timeStamp,
      nonceStr: np.nonceStr,
      package: np.wechatPackage,
      signType: np.signType,
      paySign: np.paySign
    });
  } catch (err) {
    console.error("POST /api/pay/prepay error", err);
    return res.status(500).json({
      error: "Internal error",
      message: err?.message || String(err),
      detail: err?.nihao || err?.wechat
    });
  }
});

// IPN
app.post("/api/nihao/ipn", async (req, res) => {
  try {
    const tx = req.body || {};
    const reference = tx.reference;

    console.log("[ipn] received:", tx);

    if (reference && payments.has(reference)) {
      const p = payments.get(reference);

      if (tx.status === "success") {
        p.status = "paid";
        p.nihaoTxId = tx.id || p.nihaoTxId;
      } else if (tx.status === "failure") {
        p.status = "failed";
        p.nihaoTxId = tx.id || p.nihaoTxId;
      }

      payments.set(reference, p);
      console.log("[ipn] updated payment:", reference, p.status);
    } else {
      console.log("[ipn] unknown reference:", reference);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("POST /api/nihao/ipn error", err);
    return res.status(200).json({ ok: true });
  }
});

// Create Shopify order ONLY after payment confirmed "paid"
app.post("/api/order/create-paid", async (req, res) => {
  try {
    const { paymentId, items, address, remark } = req.body || {};
    if (!paymentId) return res.status(400).json({ error: "Missing paymentId" });

    const p = payments.get(paymentId);
    if (!p) return res.status(404).json({ error: "Unknown paymentId" });

    if (p.orderId) {
      return res.json({ success: true, orderId: p.orderId, alreadyCreated: true });
    }

    if (p.status !== "paid") {
      return res.status(409).json({ error: "PAYMENT_NOT_CONFIRMED", status: p.status });
    }

    const ship = address || p.address || {};
    const fullName = ship.userName || "WeChat Customer";

    const shippingAddress = {
      address1: ship.detailInfo || "",
      address2: "",
      city: ship.cityName || "",
      province: ship.provinceName || "",
      zip: ship.postalCode || "",
      country: "China",
      firstName: fullName,
      lastName: "",
      phone: ship.telNumber || ""
    };

    const lineItems = (items || p.items || []).map((it) => ({
      variantId: it.variantId,
      quantity: Number(it.quantity) || 1
    }));

    if (!lineItems.length) return res.status(400).json({ error: "No line items" });

    const orderMutation = `
      mutation createOrder($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          order { id name }
          userErrors { field message }
        }
      }
    `;

    const orderInput = {
      email: "no-email@example.com",
      shippingAddress,
      lineItems,
      tags: ["WeChat Mini Program", "NihaoPay", `payment:${paymentId}`],
      note: `Paid via NihaoPay. paymentId=${paymentId}\nwx_openid=${p.openid || ""}\n备注: ${remark || p.remark || ""}\nTel: ${ship.telNumber || ""}`
    };

    const orderData = await shopifyAdminGraphQL(orderMutation, { order: orderInput });
    const result = orderData.orderCreate;

    if (result.userErrors && result.userErrors.length) {
      return res.status(400).json({ error: "Shopify order error", details: result.userErrors });
    }

    p.orderId = result.order.id;
    payments.set(paymentId, p);

    // ✅ Store openid on the order as a metafield (persistent)
    if (p.openid) {
      const setMeta = `
        mutation setMeta($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id key namespace }
            userErrors { field message }
          }
        }
      `;
      await shopifyAdminGraphQL(setMeta, {
        metafields: [
          {
            ownerId: result.order.id,
            namespace: "wechat",
            key: "openid",
            type: "single_line_text_field",
            value: String(p.openid)
          }
        ]
      });
    }

    return res.json({ success: true, order: result.order });
  } catch (err) {
    console.error("POST /api/order/create-paid error", err);
    return res.status(500).json({ error: "Internal error", message: err?.message || String(err) });
  }
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

    const data = await shopifyAdminGraphQL(ORDER_LIST_QUERY, { query: `phone:${phone}` });

    const out = (data.orders.nodes || []).map((o) => {
      const status = toMiniStatus(o.displayFinancialStatus, o.displayFulfillmentStatus);
      return {
        id: o.id,
        name: o.name,
        date: o.createdAt.replace("T", " ").slice(0, 16),
        total: o.currentTotalPriceSet.shopMoney.amount,
        status,
        ...badgeForStatus(status),
        itemsSummary: o.lineItems.nodes.map((li) => `${li.title} ×${li.quantity}`).join("，")
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
    const data = await shopifyAdminGraphQL(ORDER_DETAIL_QUERY, { id: req.params.id });

    const o = data.order;
    if (!o) return res.status(404).json({ error: "Order not found" });

    const status = toMiniStatus(o.displayFinancialStatus, o.displayFulfillmentStatus);

    const addr = o.shippingAddress || {};
    const tracking = o.fulfillments?.[0]?.trackingInfo?.[0];

    res.json({
      id: o.id,
      name: o.name,
      date: o.createdAt.replace("T", " ").slice(0, 16),
      status,
      ...badgeForStatus(status),
      items: o.lineItems.nodes.map((li) => ({
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
        full: [addr.country, addr.province, addr.city, addr.address1, addr.address2, addr.zip].filter(Boolean).join(" ")
      },
      tracking: tracking ? { company: tracking.company, number: tracking.number, url: tracking.url } : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------- SHOPIFY WEBHOOK: fulfillment create/update -------------------
// Create Shopify webhooks for:
// - fulfillments/create
// - fulfillments/update
// Point them to:  POST  https://wechat-shopify-server.onrender.com/api/webhooks/fulfillment

const ORDER_FOR_NOTIFY_QUERY = `
query OrderNotify($id: ID!) {
  order(id: $id) {
    id
    name
    fulfillments(first: 5) {
      trackingInfo { company number url }
    }
    metafield(namespace:"wechat", key:"openid") { value }
  }
}
`;

app.post("/api/webhooks/fulfillment", async (req, res) => {
  try {
    // Verify webhook
    if (!verifyShopifyHmac(req)) {
      console.log("[webhook] invalid hmac");
      return res.status(401).send("invalid hmac");
    }

    // Shopify fulfillments webhook payload has numeric order_id
    const orderIdNum = req.body && req.body.order_id;
    if (!orderIdNum) {
      return res.status(200).json({ ok: true, skipped: true, reason: "NO_ORDER_ID" });
    }

    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    const data = await shopifyAdminGraphQL(ORDER_FOR_NOTIFY_QUERY, { id: orderGid });
    const order = data.order;
    if (!order) return res.status(200).json({ ok: true, skipped: true, reason: "ORDER_NOT_FOUND" });

    const openid = order.metafield?.value || "";
    const tracking = order.fulfillments?.[0]?.trackingInfo?.[0] || null;

    // If there is no tracking yet, still send “shipped” with placeholders
    const company = tracking?.company || "PostNL";
    const number = tracking?.number || "";
    const shipTime = new Date().toISOString().replace("T", " ").slice(0, 16);

    // Attempt send
    const result = await sendWeChatShipMessage({
      openid,
      orderGid,
      orderName: order.name,
      logisticsCompany: company,
      trackingNumber: number,
      shipTime
    });

    return res.status(200).json({ ok: true, sent: true, result });
  } catch (e) {
    console.error("[webhook] error:", e.message || e);

    // Always 200 so Shopify doesn't retry forever while we're iterating keys.
    // We'll use logs to fix any template key mismatch.
    return res.status(200).json({ ok: true, sent: false, error: String(e.message || e) });
  }
});

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
