import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as paypal from "./src/paypal.js";
import { chat, resetConversation } from "./src/agent.js";
import { usingChannel3 } from "./src/catalog.js";
import { sanitizeRules } from "./src/policy.js";
import { getState, save, reset } from "./src/store.js";
import { spendingStatus, startApproval, completeApproval, declinePurchase, refundPurchase } from "./src/purchases.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public")));

const PORT = Number(process.env.PORT) || 3000;
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

// Wrap async handlers so errors become JSON instead of crashing the process.
const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.message, debugId: err.debugId });
  }
};

function snapshot() {
  const { wallet, purchases } = getState();
  return {
    ...spendingStatus(),
    wallet: wallet ? { email: wallet.email, linkedAt: wallet.linkedAt } : null,
    purchases,
  };
}

app.get(
  "/api/config",
  route(() => ({
    paypalClientId: paypal.clientId,
    paypalMock: paypal.mock,
    catalog: usingChannel3 ? "channel3" : "demo",
    aiReady: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  })),
);

app.get("/api/state", route(snapshot));

app.put(
  "/api/rules",
  route((req) => {
    getState().rules = sanitizeRules(req.body);
    save();
    return snapshot();
  }),
);

app.post(
  "/api/chat",
  route(async (req) => {
    const message = String(req.body?.message || "").trim().slice(0, 2000);
    if (!message) throw Object.assign(new Error("Message is empty."), { status: 400 });
    const result = await chat(message);
    return { ...result, state: snapshot() };
  }),
);

app.post(
  "/api/chat/reset",
  route(() => {
    resetConversation();
    return { ok: true };
  }),
);

// --- Link a PayPal wallet (Vault) ---------------------------------------------

app.post(
  "/api/wallet/setup-token",
  route(async (req) => {
    const token = await paypal.createSetupToken({ returnUrl: `${baseUrl(req)}/?linked=1`, cancelUrl: `${baseUrl(req)}/?linked=0` });
    return { id: token.id };
  }),
);

app.post(
  "/api/wallet/link",
  route(async (req) => {
    const setupTokenId = String(req.body?.vaultSetupToken || "");
    if (!setupTokenId) throw Object.assign(new Error("vaultSetupToken is required."), { status: 400 });
    const pt = await paypal.createPaymentToken(setupTokenId);
    getState().wallet = {
      vaultId: pt.id,
      customerId: pt.customer?.id ?? null,
      email: pt.payment_source?.paypal?.email_address ?? null,
      linkedAt: new Date().toISOString(),
    };
    save();
    return snapshot();
  }),
);

app.delete(
  "/api/wallet",
  route(async () => {
    const { wallet } = getState();
    if (wallet?.vaultId) await paypal.deletePaymentToken(wallet.vaultId).catch((e) => console.warn("unlink:", e.message));
    getState().wallet = null;
    save();
    return snapshot();
  }),
);

// --- Human approval and refunds -----------------------------------------------

app.post("/api/purchases/:id/order", route(async (req) => ({ orderId: await startApproval(req.params.id) })));

app.post(
  "/api/purchases/:id/capture",
  route(async (req) => {
    const purchase = await completeApproval(req.params.id, String(req.body?.orderId || ""));
    return { purchase, state: snapshot() };
  }),
);

app.post("/api/purchases/:id/decline", route((req) => ({ purchase: declinePurchase(req.params.id), state: snapshot() })));

app.post("/api/purchases/:id/refund", route(async (req) => ({ purchase: await refundPurchase(req.params.id), state: snapshot() })));

app.post(
  "/api/reset",
  route(() => {
    reset({ keepWallet: true });
    return snapshot();
  }),
);

app.listen(PORT, () => {
  console.log(`Errand running at http://localhost:${PORT}`);
  console.log(`  PayPal:  ${paypal.mock ? "MOCK mode (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)" : "sandbox"}`);
  console.log(`  Catalog: ${usingChannel3 ? "Channel3" : "built-in demo catalog (set CHANNEL3_API_KEY for real products)"}`);
});
