// Thin client for the PayPal REST APIs Errand uses:
//   Vault v3      - save the user's PayPal wallet once, so the agent can pay later
//   Orders v2     - charge the saved wallet, or create an order the user approves
//   Payments v2   - refund a capture ("undo" in the activity log)
// With no credentials (or PAYPAL_MOCK=1) it simulates PayPal so the UI still runs.

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";

export const mock = process.env.PAYPAL_MOCK === "1" || !CLIENT_ID || !CLIENT_SECRET;
export const clientId = CLIENT_ID;

export class PayPalError extends Error {
  constructor(status, body) {
    const detail = body?.details?.[0];
    super(`PayPal ${status}: ${detail?.issue || body?.name || "error"}${detail?.description ? ` - ${detail.description}` : body?.message ? ` - ${body.message}` : ""}`);
    this.status = status;
    this.body = body;
    this.debugId = body?.debug_id;
  }
}

let token = null; // { value, expiresAt }

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body);
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function call(method, path, body, { requestId } = {}) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId; // makes retries idempotent
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, json);
  return json;
}

const money = (value, currency = "USD") => ({ currency_code: currency, value: Number(value).toFixed(2) });

function purchaseUnit(purchase) {
  const name = purchase.title.slice(0, 127);
  return {
    reference_id: purchase.id,
    custom_id: purchase.id,
    description: `Errand agent: ${name}`.slice(0, 127),
    amount: {
      ...money(purchase.amount, purchase.currency),
      breakdown: { item_total: money(purchase.amount, purchase.currency) },
    },
    items: [{ name, quantity: "1", unit_amount: money(purchase.amount, purchase.currency), category: "PHYSICAL_GOODS" }],
  };
}

const fakeId = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 12).toUpperCase()}`;

// --- Vault: link a wallet once --------------------------------------------

export async function createSetupToken({ returnUrl, cancelUrl }) {
  if (mock) return { id: fakeId("MOCK-SETUP-") };
  return call("POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: "Lets your Errand agent pay within the spending rules you set",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          shipping_preference: "NO_SHIPPING",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  });
}

export async function createPaymentToken(setupTokenId) {
  if (mock) {
    return { id: fakeId("MOCK-VAULT-"), customer: { id: fakeId("MOCK-CUST-") }, payment_source: { paypal: { email_address: "sandbox-buyer@example.com" } } };
  }
  return call("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, { requestId: `pt-${setupTokenId}` });
}

export async function deletePaymentToken(vaultId) {
  if (mock) return;
  await call("DELETE", `/v3/vault/payment-tokens/${vaultId}`);
}

// --- Orders -----------------------------------------------------------------

/** Charge the saved wallet with no buyer interaction. Returns { orderId, captureId, status }. */
export async function chargeVaultedWallet(purchase, vaultId) {
  if (mock) return { orderId: fakeId("MOCK-ORDER-"), captureId: fakeId("MOCK-CAP-"), status: "COMPLETED" };
  const order = await call(
    "POST",
    "/v2/checkout/orders",
    { intent: "CAPTURE", purchase_units: [purchaseUnit(purchase)], payment_source: { paypal: { vault_id: vaultId } } },
    { requestId: `charge-${purchase.id}` },
  );
  return { orderId: order.id, captureId: captureIdOf(order), status: order.status };
}

/** Create an order the human approves in the PayPal popup. */
export async function createOrderForApproval(purchase) {
  if (mock) return { id: fakeId("MOCK-ORDER-") };
  return call("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [purchaseUnit(purchase)] }, { requestId: `order-${purchase.id}` });
}

export async function captureOrder(orderId) {
  if (mock) return { orderId, captureId: fakeId("MOCK-CAP-"), status: "COMPLETED" };
  const order = await call("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { requestId: `capture-${orderId}` });
  return { orderId: order.id, captureId: captureIdOf(order), status: order.status };
}

export async function refundCapture(captureId) {
  if (mock) return { id: fakeId("MOCK-REFUND-"), status: "COMPLETED" };
  return call("POST", `/v2/payments/captures/${captureId}/refund`, {}, { requestId: `refund-${captureId}` });
}

function captureIdOf(order) {
  return order?.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
}
