// server.js (NihaoPay + Shopify bridge for WeChat Mini Program)
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

// ---- Shopify ----
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "edd11f-2.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";

// ---- WeChat (for openid) ----
const WX_APPID = process.env.WX_APPID || "";
const WX_SECRET = process.env.WX_SECRET || "";

// ---- NihaoPay ----
const NIHAOPAY_TOKEN = process.env.NIHAOPAY_TOKEN || "";
const NIHAOPAY_IPN_URL = process.env.NIHAOPAY_IPN_URL || "";

// Optional: merchant id (NOT required by micropay API call in this flow)
const NIHAOPAY_MERCHANT_ID = process.env.NIHAOPAY_MERCHANT_ID || "";

// In-memory payment store (OK for MVP; production should use DB/Redis)
const payments = new Map(); // paymentId(reference) -> { status, amountFen, items, address, remark, nihaoTxId, orderId }

function assertEnv(name, val) {
  if (!val) {
    const err = new Error(`Missing env var: ${name}`);
    err.code = "MISSING_ENV";
    throw err;
  }
}

function toFen(amountCNY) {
  const n = Number(amountCNY);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function genReference() {
  const rand = crypto.randomBytes(4).toString("hex"); // 8 chars
  return `wx${Date.now()}${rand}`.slice(0, 30);
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  if (req.ip) return req.ip.replace("::ffff:", "");
  return "127.0.0.1";
}

async function shopifyAdminGraphQL(query, variables = {}) {
  if (!ADMIN_TOKEN) {
    const err = new Error("Missing ADMIN_TOKEN (SHOPIFY_ADMIN_TOKEN on Render)");
    err.code = "MISSING_ADMIN_TOKEN";
    throw err;
  }

  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    const err = new Error(`Shopify returned non-JSON. HTTP ${res.status}. Body: ${text}`);
    err.httpStatus = res.status;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Shopify HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.shopify = json;
    throw err;
  }

  if (json.errors && json.errors.length) {
    const err = new Error(json.errors.map((e) => e.message).join(" | "));
    err.httpStatus = 500;
    err.shopifyErrors = json.errors;
    throw err;
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
    const err = new Error(`WeChat jscode2session error: ${JSON.stringify(json)}`);
    err.wechat = json;
    throw err;
  }

  if (!json.openid) {
    const err = new Error(`WeChat missing openid: ${JSON.stringify(json)}`);
    err.wechat = json;
    throw err;
  }

  return json.openid;
}

async function nihaoMicropay({ rmb_amount, reference, open_id, client_ip, description, note }) {
  assertEnv("NIHAOPAY_TOKEN", NIHAOPAY_TOKEN);
  assertEnv("NIHAOPAY_IPN_URL", NIHAOPAY_IPN_URL);
  assertEnv("WX_APPID", WX_APPID); // <-- KEY: use WeChat AppID as NihaoPay app_id

  const form = new URLSearchParams();
  form.set("currency", "CNY");
  form.set("rmb_amount", String(rmb_amount));
  form.set("reference", reference);
  form.set("ipn_url", NIHAOPAY_IPN_URL);
  form.set("open_id", open_id);
  form.set("client_ip", client_ip);

  // IMPORTANT: NihaoPay "app_id" here is your WeChat Mini Program AppID
  form.set("app_id", WX_APPID);

  // Optional (for your own debugging/support)
  if (NIHAOPAY_MERCHANT_ID) form.set("merchant_id", NIHAOPAY_MERCHANT_ID);

  if (description) form.set("description", description);
  if (note) form.set("note", note);

  const res = await fetch("https://api.nihaopay.com/v1.2/transactions/micropay", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NIHAOPAY_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    const err = new Error(`NihaoPay non-JSON. HTTP ${res.status}. Body: ${text}`);
    err.httpStatus = res.status;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`NihaoPay HTTP ${res.status}: ${text}`);
    err.httpStatus = res.status;
    err.nihao = json;
    throw err;
  }

  return json;
}

// Health check
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

// ✅ PREPAY (NihaoPay → returns wx.requestPayment params)
app.post("/api/pay/prepay", async (req, res) => {
  try {
    const { wxCode, amountCNY, items, address, remark } = req.body || {};
    if (!wxCode) return res.status(400).json({ error: "Missing wxCode" });

    const amountFen = toFen(amountCNY);
    if (!amountFen) return res.status(400).json({ error: "Invalid amountCNY" });

    const openid = await wechatCodeToOpenId(wxCode);
    const client_ip = getClientIp(req);

    const paymentId = genReference();

    payments.set(paymentId, {
      status: "pending",
      amountFen,
      items: items || [],
      address: address || null,
      remark: remark || "",
      nihaoTxId: null,
      orderId: null
    });

    const np = await nihaoMicropay({
      rmb_amount: amountFen,
      reference: paymentId,
      open_id: openid,
      client_ip,
      description: "Erethereal WeChat Mini Program",
      note: remark || "WeChat Mini Program"
    });

    return res.json({
      paymentId,
      timeStamp: np.timeStamp,
      nonceStr: np.nonceStr,
      package: np.wechatPackage, // IMPORTANT: must be "prepay_id=..."
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

// ✅ IPN (NihaoPay calls this after payment completes)
app.post("/api/nihao/ipn", async (req, res) => {
  try {
    const tx = req.body || {};
    const reference = tx.reference;

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
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("POST /api/nihao/ipn error", err);
    return res.status(200).json({ ok: true });
  }
});

// ✅ Create Shopify order ONLY if payment confirmed paid
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
      note: `Paid via NihaoPay. paymentId=${paymentId}\n备注: ${remark || p.remark || ""}\nTel: ${ship.telNumber || ""}`
    };

    const orderData = await shopifyAdminGraphQL(orderMutation, { order: orderInput });
    const result = orderData.orderCreate;

    if (result.userErrors && result.userErrors.length) {
      return res.status(400).json({ error: "Shopify order error", details: result.userErrors });
    }

    p.orderId = result.order.id;
    payments.set(paymentId, p);

    return res.json({ success: true, order: result.order });
  } catch (err) {
    console.error("POST /api/order/create-paid error", err);
    return res.status(500).json({ error: "Internal error", message: err?.message || String(err) });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Wechat-Shopify server running on port", PORT);
});
