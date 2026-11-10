import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as paypal from "./src/paypal.js";
import { createMandate, revokeMandate, listMandates, mandateForToken, publicMandate } from "./src/mandates.js";
import { requestPayment, approvePayment, declinePayment, refundPayment, releaseHolds, agentView } from "./src/payments.js";
import { chat, resetConversation } from "./src/agent.js";
import { draftMandate } from "./src/drafter.js";
import { usingChannel3 } from "./src/catalog.js";
import { getState, save, reset } from "./src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public"), { extensions: ["html"] }));

const PORT = Number(process.env.PORT) || 3000;
const baseUrl = (req) => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
// On a shared hosted demo, cap the calls that spend AI credits.
const PUBLIC_DEMO = process.env.PUBLIC_DEMO === "1" || Boolean(process.env.RENDER);

const aiReady = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Simple per-IP limiter for the hosted demo: `max` requests per hour per bucket.
const hits = new Map();
const limit = (bucket, max) => (req, res, next) => {
  if (!PUBLIC_DEMO) return next();
  const key = `${bucket}:${req.ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= max) return res.status(429).json({ error: "Demo rate limit reached. Try again in a bit." });
  recent.push(now);
  hits.set(key, recent);
  next();
};
if (PUBLIC_DEMO) app.set("trust proxy", 1);

// Wrap async handlers so errors become JSON instead of crashing the process.
const route = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (err) {
    if (!err.status || err.status >= 500) console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message, debugId: err.debugId });
  }
};

// ---------------------------------------------------------------------------
// Agent API: what AI agents call, authenticated with a mandate token.
// ---------------------------------------------------------------------------

function requireMandate(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const mandate = mandateForToken(token);
  if (!mandate) throw Object.assign(new Error("Unknown or missing mandate token."), { status: 401 });
  return mandate;
}

app.get(
  "/v1/mandate",
  route((req) => {
    const m = publicMandate(requireMandate(req));
    return {
      mandate_id: m.id,
      agent_name: m.agentName,
      status: m.status,
      purpose: m.purpose,
      currency: m.currency,
      per_purchase_limit: m.perPurchaseLimit,
      auto_approve_limit: m.autoApproveLimit,
      total_limit: m.totalLimit,
      remaining: m.remaining,
      max_payments_per_day: m.maxPaymentsPerDay,
      allowed_merchants: m.allowedMerchants,
      expires_at: m.expiresAt,
    };
  }),
);

app.post(
  "/v1/payments",
  limit("pay", 60),
  route(async (req, res) => {
    const mandate = requireMandate(req);
    const key = req.get("idempotency-key")?.slice(0, 200);
    const payment = await requestPayment({ mandate, cartInput: req.body, idempotencyKey: key });
    res.status(201).json(agentView(payment));
  }),
);

app.get(
  "/v1/payments/:id",
  route((req) => {
    const mandate = requireMandate(req);
    const p = getState().payments.find((x) => x.id === req.params.id && x.mandateId === mandate.id);
    if (!p) throw Object.assign(new Error("No such payment for this mandate."), { status: 404 });
    return agentView(p);
  }),
);

// ---------------------------------------------------------------------------
// Owner dashboard API. (Single-owner prototype: no login, run it locally.)
// ---------------------------------------------------------------------------

function overview() {
  const { wallet, payments } = getState();
  return {
    wallet: wallet ? { email: wallet.email, linkedAt: wallet.linkedAt } : null,
    mandates: listMandates(),
    payments: payments.slice(0, 100),
  };
}

app.get(
  "/api/config",
  route(() => ({
    paypalClientId: paypal.clientId,
    paypalMock: paypal.mock,
    catalog: usingChannel3 ? "channel3" : "demo",
    aiReady: aiReady(),
    publicDemo: PUBLIC_DEMO,
  })),
);

app.get("/api/overview", route(overview));

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
    return overview();
  }),
);

app.delete(
  "/api/wallet",
  route(async () => {
    const { wallet } = getState();
    if (wallet?.vaultId) await paypal.deletePaymentToken(wallet.vaultId).catch((e) => console.warn("unlink:", e.message));
    getState().wallet = null;
    save();
    return overview();
  }),
);

app.post(
  "/api/mandates",
  route((req) => {
    const { mandate, token } = createMandate(req.body);
    return {
      mandate,
      token,
      mcpConfig: {
        mcpServers: {
          agentpass: {
            command: "node",
            args: [process.env.RENDER ? "/path/to/agentpass/mcp/server.js" : path.join(here, "mcp", "server.js")],
            env: { AGENTPASS_URL: baseUrl(req), AGENTPASS_TOKEN: token },
          },
        },
      },
    };
  }),
);

app.post(
  "/api/mandates/draft",
  limit("ai", 30),
  route(async (req) => {
    const text = String(req.body?.text || "").trim();
    if (text.length < 10) throw Object.assign(new Error("Describe what the agent may buy, with any limits."), { status: 400 });
    return draftMandate(text);
  }),
);

app.post(
  "/api/mandates/:id/revoke",
  route(async (req) => {
    revokeMandate(req.params.id);
    await releaseHolds(req.params.id);
    return overview();
  }),
);

app.post("/api/payments/:id/approve", route(async (req) => ({ payment: await approvePayment(req.params.id), ...overview() })));
app.post("/api/payments/:id/decline", route(async (req) => ({ payment: await declinePayment(req.params.id), ...overview() })));
app.post("/api/payments/:id/refund", route(async (req) => ({ payment: await refundPayment(req.params.id), ...overview() })));

app.post(
  "/api/reset",
  route(() => {
    reset({ keepWallet: true });
    return overview();
  }),
);

// ---------------------------------------------------------------------------
// Errand demo agent. It calls the agent API above over HTTP, like any agent.
// ---------------------------------------------------------------------------

app.post(
  "/api/errand/chat",
  limit("ai", 30),
  route(async (req) => {
    const message = String(req.body?.message || "").trim().slice(0, 2000);
    const token = String(req.body?.token || "");
    if (!message) throw Object.assign(new Error("Message is empty."), { status: 400 });
    if (!token) throw Object.assign(new Error("Paste a mandate token first."), { status: 400 });
    return chat(message, { agentPassUrl: `http://127.0.0.1:${PORT}`, token });
  }),
);

app.post(
  "/api/errand/reset",
  route(() => {
    resetConversation();
    return { ok: true };
  }),
);

app.listen(PORT, () => {
  console.log(`AgentPass running at http://localhost:${PORT}  (Errand demo agent at /errand)`);
  console.log(`  Claude:  ${aiReady() ? "ready" : "set ANTHROPIC_API_KEY (intent checks fail closed to owner review without it)"}`);
  console.log(`  PayPal:  ${paypal.mock ? "SIMULATED (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)" : "sandbox"}`);
  console.log(`  Catalog: ${usingChannel3 ? "Channel3" : "built-in demo catalog (set CHANNEL3_API_KEY for real products)"}`);
});
