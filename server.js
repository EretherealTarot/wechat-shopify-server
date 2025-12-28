// server.js (tiny Shopify bridge for WeChat) — FIXED (no cors dependency)
const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2

const app = express();
app.use(express.json({ limit: "2mb" }));

// Simple CORS (no dependency)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- CONFIG: real values via env ----
// NOTE: Keep your existing env var names so Render doesn't need changes.
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "edd11f-2.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || ""; // set in Render
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";
// ----------------------------------------------------

async function shopifyAdminGraphQL(query, variables = {}) {
  if (!ADMIN_TOKEN) {
    const err = new Error(
      "Missing ADMIN_TOKEN (set SHOPIFY_ADMIN_TOKEN env var on Render)"
    );
    err.code = "MISSING_ADMIN_TOKEN";
    throw err;
  }

  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const err = new Error(
      `Shopify returned non-JSON. HTTP ${res.status}. Body: ${text}`
    );
    err.httpStatus = res.status;
    throw err;
  }

  // HTTP-level errors
  if (!res.ok) {
    console.error("Shopify HTTP error", res.status, json);
    const err = new Error(`Shopify HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.shopify = json;
    throw err;
  }

  // GraphQL top-level errors
  if (json.errors && json.errors.length) {
    console.error("Shopify GraphQL errors", json.errors);
    const err = new Error(json.errors.map((e) => e.message).join(" | "));
    err.httpStatus = 500;
    err.shopifyErrors = json.errors;
    throw err;
  }

  return json.data;
}

// Health check
app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "wechat-shopify-server" });
});

// ========== 1) REAL INVENTORY LOOKUP ==========
app.get("/api/stock", async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) {
      return res.status(400).json({ error: "Missing productId" });
    }

    const query = `
      query getStock($id: ID!) {
        product(id: $id) {
          id
          totalInventory
        }
      }
    `;

    const data = await shopifyAdminGraphQL(query, { id: productId });
    const product = data.product;
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const qty = product.totalInventory ?? 0;
    return res.json({
      productId,
      quantity: qty,
      available: qty > 0,
    });
  } catch (err) {
    console.error("GET /api/stock error", err);
    return res.status(500).json({
      error: "Internal error",
      message: err?.message || String(err),
      shopifyErrors: err?.shopifyErrors,
      shopify: err?.shopify,
    });
  }
});

// ========== 2) CREATE ORDER (NO CUSTOM PRICE OVERRIDE) ==========
app.post("/api/create-order", async (req, res) => {
  try {
    const { productId, quantity, email, note } = req.body || {};

    if (!productId || !quantity) {
      return res.status(400).json({ error: "Missing productId or quantity" });
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    // 1) Get variant ID for that product
    const variantQuery = `
      query getVariant($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 1) {
            edges {
              node { id }
            }
          }
        }
      }
    `;

    const varData = await shopifyAdminGraphQL(variantQuery, { id: productId });
    const product = varData.product;

    if (!product || !product.variants?.edges?.length) {
      return res.status(404).json({ error: "Product or variant not found" });
    }

    const variantId = product.variants.edges[0].node.id;

    // 2) Create the order (NO originalUnitPrice, NO financialStatus)
    const orderMutation = `
      mutation createOrder($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          order {
            id
            name
            email
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const orderInput = {
      email: email || "no-email@example.com",
      lineItems: [
        {
          quantity: qty,
          variantId: variantId,
        },
      ],
      tags: ["WeChat Mini Program"],
      note: note || "Order from WeChat Mini Program",
    };

    const orderData = await shopifyAdminGraphQL(orderMutation, {
      order: orderInput,
    });

    const result = orderData.orderCreate;

    if (result.userErrors && result.userErrors.length) {
      console.error("orderCreate userErrors", result.userErrors);
      return res.status(400).json({
        error: "Shopify order error",
        details: result.userErrors,
      });
    }

    return res.json({
      success: true,
      order: result.order,
    });
  } catch (err) {
    console.error("POST /api/create-order error", err);
    return res.status(500).json({
      error: "Internal error",
      message: err?.message || String(err),
      shopifyErrors: err?.shopifyErrors,
      shopify: err?.shopify,
    });
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Wechat-Shopify server running on port", PORT);
});
