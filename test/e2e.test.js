// End to end without keys: the real HTTP server, agent API, mandate checks,
// payment pipeline, Errand agent loop and MCP server, with simulated PayPal and
// scripted stand-ins for the two Claude calls (the agent and the intent check).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpass-"));
process.env.STATE_FILE = path.join(dir, "state.json");
process.env.PAYPAL_MOCK = "1";
process.env.PORT = String(41000 + Math.floor(Math.random() * 1000));
delete process.env.CHANNEL3_API_KEY;
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const { _setVerifierClientForTests } = await import("../src/verifier.js");
const { _setClientForTests } = await import("../src/agent.js");
await import("../server.js");
await new Promise((r) => setTimeout(r, 200));

const verdict = (v) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(v) }] });
// Intent check stand-in: rejects anything office-y, reviews "grinder", approves the rest, throws on "explode".
const verifierCalls = [];
_setVerifierClientForTests({
  messages: {
    create: async (params) => {
      verifierCalls.push(params);
      const text = params.messages[0].content;
      if (text.includes("explode")) throw new Error("API down");
      if (/paper|toner/i.test(text)) return verdict({ decision: "reject", risk_score: 85, reasons: ["Office supplies aren't a gift for dad."] });
      if (/grinder/i.test(text)) return verdict({ decision: "needs_review", risk_score: 40, reasons: ["Pricier than usual."] });
      return verdict({ decision: "approve", risk_score: 5, reasons: ["A fishing gift fits."] });
    },
  },
});

const j = async (method, p, body, headers = {}) => {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const owner = (method, p, body) => j(method, p, body).then((r) => r.body);
let token, mandateId;
const agent = (method, p, body, extra = {}) => j(method, p, body, { Authorization: `Bearer ${token}`, ...extra });
const cart = (name, price, extra = {}) => ({ merchant: "demo-store.example", items: [{ name, unit_price: price, quantity: 1 }], description: "for dad", ...extra });

before(async () => {
  await owner("POST", "/api/wallet/link", { vaultSetupToken: "MOCK" });
  const r = await owner("POST", "/api/mandates", { agentName: "Errand", purpose: "Birthday gifts for my dad, he fishes", perPurchaseLimit: 80, autoApproveLimit: 40, totalLimit: 400, maxPaymentsPerDay: 20 });
  token = r.token;
  mandateId = r.mandate.id;
  assert.match(token, /^apm_/);
  assert.equal(r.mcpConfig.mcpServers.agentpass.env.AGENTPASS_TOKEN, token);
  assert.equal(JSON.stringify(await owner("GET", "/api/overview")).includes(token), false, "token must never be returned again");
});
after(() => setTimeout(() => process.exit(0), 50));

test("agent API needs a valid token", async () => {
  assert.equal((await j("GET", "/v1/mandate")).status, 401);
  assert.equal((await j("GET", "/v1/mandate", null, { Authorization: "Bearer apm_nope" })).status, 401);
  const m = await agent("GET", "/v1/mandate");
  assert.equal(m.body.remaining, 400);
});

test("small, on-purpose payment is captured; same idempotency key doesn't pay twice", async () => {
  const a = await agent("POST", "/v1/payments", cart("Tackle box", 34.99), { "Idempotency-Key": "k1" });
  assert.equal(a.status, 201);
  assert.equal(a.body.status, "captured");
  const b = await agent("POST", "/v1/payments", cart("Tackle box", 34.99), { "Idempotency-Key": "k1" });
  assert.equal(b.body.payment_id, a.body.payment_id);
  assert.equal((await agent("GET", "/v1/mandate")).body.remaining, 365.01);
});

test("hard limits reject without calling the AI", async () => {
  const before = verifierCalls.length;
  const r = await agent("POST", "/v1/payments", cart("Rod", 95));
  assert.equal(r.body.status, "rejected");
  assert.match(r.body.reasons[0], /per-purchase/);
  const g = await agent("POST", "/v1/payments", cart("$50 gift card", 50));
  assert.equal(g.body.status, "rejected");
  assert.equal(verifierCalls.length, before);
});

test("AI intent check rejects off-purpose purchases", async () => {
  const r = await agent("POST", "/v1/payments", cart("Copy paper, 5 reams", 31.49));
  assert.equal(r.body.status, "rejected");
  assert.match(r.body.reasons[0], /aren't a gift/);
});

test("over the auto limit is held in PayPal; owner approves and it captures", async () => {
  const r = await agent("POST", "/v1/payments", cart("Burr grinder", 64.99));
  assert.equal(r.body.status, "held");
  const ov = await owner("GET", "/api/overview");
  const held = ov.payments.find((p) => p.id === r.body.payment_id);
  assert.match(held.paypal.authorizationId, /^MOCK-AUTH-/);
  await owner("POST", `/api/payments/${held.id}/approve`);
  assert.equal((await agent("GET", `/v1/payments/${held.id}`)).body.status, "captured");
});

test("intent check outage fails closed to a hold; owner declines and it voids", async () => {
  const r = await agent("POST", "/v1/payments", cart("explode hat", 10));
  assert.equal(r.body.status, "held");
  assert.match(r.body.reasons[0], /unavailable/);
  await owner("POST", `/api/payments/${r.body.payment_id}/decline`);
  assert.equal((await agent("GET", `/v1/payments/${r.body.payment_id}`)).body.status, "declined");
});

test("refund frees budget", async () => {
  const left = (await agent("GET", "/v1/mandate")).body.remaining;
  const ov = await owner("GET", "/api/overview");
  const paid = ov.payments.find((p) => p.status === "captured" && p.amount === 34.99);
  await owner("POST", `/api/payments/${paid.id}/refund`);
  assert.equal((await agent("GET", "/v1/mandate")).body.remaining, Math.round((left + 34.99) * 100) / 100);
});

test("the Errand demo agent pays through the HTTP API", async () => {
  const toolUse = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
  const last = (p) => JSON.parse(p.messages.at(-1).content[0].content);
  const steps = [
    () => toolUse("t1", "search_products", { query: "fishing tackle box" }),
    (p) => toolUse("t2", "pay_for_product", { product_id: last(p).results[0].product_id, reason: "He fishes." }),
    (p) => {
      assert.equal(last(p).status, "captured");
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Bought it." }] };
    },
  ];
  _setClientForTests({ beta: { messages: { create: async (p) => steps.shift()(p) } } });
  const r = await owner("POST", "/api/errand/chat", { message: "fishing gift for dad", token });
  assert.equal(r.text, "Bought it.");
  assert.deepEqual(r.events.map((e) => e.type), ["products", "payment"]);
});

test("MCP server exposes the agent API to any MCP client", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.resolve("mcp/server.js")], env: { ...process.env, AGENTPASS_URL: BASE, AGENTPASS_TOKEN: token } }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["agentpass_get_mandate", "agentpass_pay", "agentpass_payment_status"]);
  const res = await client.callTool({ name: "agentpass_pay", arguments: { merchant: "rei.com", items: [{ name: "Fishing hat", unit_price: 22.5, quantity: 1 }], description: "Sun hat for fishing trips" } });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.status, "captured");
  const st = await client.callTool({ name: "agentpass_payment_status", arguments: { payment_id: out.payment_id } });
  assert.equal(JSON.parse(st.content[0].text).status, "captured");
  await client.close();
});

test("revoking a mandate kills the token's spending and releases holds", async () => {
  const h = await agent("POST", "/v1/payments", cart("Burr grinder", 64.99));
  assert.equal(h.body.status, "held");
  await owner("POST", `/api/mandates/${mandateId}/revoke`);
  assert.equal((await agent("GET", `/v1/payments/${h.body.payment_id}`)).body.status, "declined");
  const r = await agent("POST", "/v1/payments", cart("Hat", 5));
  assert.equal(r.body.status, "rejected");
  assert.match(r.body.reasons.join(" "), /revoked/);
});
