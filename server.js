// server.js — Shopify bridge server for WeChat Mini Program
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// -----------------------------------------
// CONFIG (tokens from environment only)
// -----------------------------------------
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "edd11f-2.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-07";

if (!SHOPIFY_DOMAIN) {
  console.error("❌ Missing SHOPIFY_DOMAIN env var");
}
if (!ADMIN_TOKEN) {
  console.error("❌ Missing SHOPIFY_ADMIN_TOKEN env var");
}

// -----------------------------------------
// Helper: call Shopify Admin GraphQL
// -----------------------------------------
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
    console.error("Shopify GraphQL errors:", json.errors);
    throw new Error(json.errors[0]?.message || "Shopify GraphQL error");
  }

  return json.data;
}

// -----------------------------------------
// 1) REAL INVENTORY LOOKUP
// -----------------------------------------
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
    const qty = data?.product?.totalInventory ?? 0;

    res.json({
      productId,
      quantity: qty,
      available: qty > 0
    });
  } catch (err) {
    console.error("GET /api/stock error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// -----------------------------------------
// 2) CREATE SHOPIFY ORDER (simple, stable)
// -----------------------------------------
app.post("/api/create-order", async (req, res) => {
  try {
    const { productId, quantity, email, note } = req.body || {};

    if (!productId || !quantity) {
      return res.status(400).json({ error: "Missing productId or quantity" });
    }

    // 1) Get a variant for this product
    const variantQuery = `
      query getVariant($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    `;

    const varData = await shopifyAdminGraphQL(variantQuery, { id: productId });
    const product = varData?.product;
    const edges = product?.variants?.edges || [];

    if (!product || !edges.length) {
      return res.status(404).json({ error: "Product or variant not found" });
    }

    const variantId = edges[0].node.id;

    // 2) Create the order with Shopify's default pricing for that variant
    const orderMutation = `
      mutation createOrder($input: OrderInput!) {
        orderCreate(input: $input) {
          order {
            id
            name
            email
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const orderInput = {
      email: email || "wechat-order@example.com",
      lineItems: [
        {
          quantity,
          variantId
        }
      ],
      tags: ["WeChat Mini Program"],
      note: note || "Order from WeChat Mini Program",
      // We consider the order already paid (AlphaPay will handle real payment later)
      financialStatus: "PAID"
    };

    const data = await shopifyAdminGraphQL(orderMutation, { input: orderInput });
    const result = data?.orderCreate;

    if (!result) {
      console.error("orderCreate missing in response:", data);
      return res.status(500).json({ error: "orderCreate missing in response" });
    }

    if (result.userErrors && result.userErrors.length) {
      console.error("orderCreate userErrors:", result.userErrors);
      return res.status(400).json({
        error: "Shopify order error",
        details: result.userErrors
      });
    }

    res.json({
      success: true,
      order: result.order
    });
  } catch (err) {
    console.error("POST /api/create-order error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// -----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Wechat-Shopify server running on port", PORT);
});