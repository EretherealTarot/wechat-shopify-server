// server.js — Shopify bridge server for WeChat Mini Program
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// CONFIG (safe: tokens loaded from Render dashboard only)
// ---------------------------------------------------------
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "edd11f-2.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-07";

if (!ADMIN_TOKEN) {
  console.error("❌ Missing SHOPIFY_ADMIN_TOKEN environment variable!");
}

// ---------------------------------------------------------
// Helper to call Shopify Admin GraphQL
// ---------------------------------------------------------
async function shopifyAdminGraphQL(query, variables = {}) {
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

  if (!res.ok) {
    console.error("Shopify HTTP error:", res.status, json);
    throw new Error(`Shopify HTTP ${res.status}`);
  }

  if (json.errors) {
    console.error("Shopify GraphQL errors", json.errors);
    throw new Error(json.errors[0]?.message || "GraphQL error");
  }

  return json.data;
}

// ---------------------------------------------------------
// 1) REAL INVENTORY LOOKUP
// ---------------------------------------------------------
app.get("/api/stock", async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) return res.status(400).json({ error: "Missing productId" });

    const query = `
      query ($id: ID!) {
        product(id: $id) {
          id
          totalInventory
        }
      }
    `;

    const data = await shopifyAdminGraphQL(query, { id: productId });
    const qty = data?.product?.totalInventory ?? 0;

    res.json({
      productId,
      quantity: qty,
      available: qty > 0
    });
  } catch (err) {
    console.error("GET /api/stock error", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------
// 2) CREATE SHOPIFY ORDER (correct API for Admin)
// ---------------------------------------------------------
app.post("/api/create-order", async (req, res) => {
  try {
    const { productId, quantity } = req.body;

    if (!productId || !quantity)
      return res.status(400).json({ error: "Missing productId or quantity" });

    // Fetch variant
    const variantQuery = `
      query ($id: ID!) {
        product(id: $id) {
          title
          variants(first: 1) {
            edges {
              node { id }
            }
          }
        }
      }
    `;

    const productData = await shopifyAdminGraphQL(variantQuery, { id: productId });
    const variantId = productData.product.variants.edges[0].node.id;

    // Create the order (correct OrderCreate mutation)
    const orderMutation = `
      mutation orderCreate($input: OrderCreateInput!) {
        orderCreate(input: $input) {
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
      email: "wechat-order@example.com",
      lineItems: [
        {
          quantity,
          variantId
        }
      ],
      tags: ["WeChat MiniProgram"],
      financialStatus: "PAID"
    };

    const result = await shopifyAdminGraphQL(orderMutation, { input: orderInput });

    if (result.orderCreate.userErrors.length > 0) {
      return res.status(400).json({
        error: "Shopify order error",
        details: result.orderCreate.userErrors
      });
    }

    res.json({
      success: true,
      order: result.orderCreate.order
    });

  } catch (err) {
    console.error("POST /api/create-order error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✔ Tiny Shopify server running on port", PORT);
});