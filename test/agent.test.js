// Drives the real agent loop, store, policy and (simulated) PayPal with a
// scripted stand-in for Claude, so the whole purchase path runs without keys.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "errand-")), "state.json");
process.env.PAYPAL_MOCK = "1";
delete process.env.CHANNEL3_API_KEY;

const { chat, _setClientForTests, resetConversation } = await import("../src/agent.js");
const store = await import("../src/store.js");

// Fake client: each call returns the next scripted response, built from the messages so far.
function scripted(steps) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const step = steps.shift();
          assert.ok(step, "agent made more model calls than scripted");
          return step(params);
        },
      },
    },
  };
}
const toolUse = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
const say = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const lastToolResult = (params) => JSON.parse(params.messages.at(-1).content[0].content);

before(() => {
  store.getState().wallet = { vaultId: "MOCK-VAULT-1", email: "buyer@example.com" };
  store.getState().rules = { monthlyBudget: 200, autoApproveLimit: 40, blockedKeywords: ["gift card"], currency: "USD" };
});

test("searches, buys within the auto limit, and pays through the vaulted wallet", async () => {
  resetConversation();
  let found;
  const client = scripted([
    () => toolUse("t1", "search_products", { query: "fishing tackle box gift", max_price: 60 }),
    (p) => {
      found = lastToolResult(p).results;
      const box = found.find((r) => r.title.includes("Tackle Box"));
      return toolUse("t2", "buy_product", { product_id: box.product_id, reason: "Fits the budget and he fishes." });
    },
    (p) => {
      const r = lastToolResult(p);
      assert.equal(r.status, "paid");
      assert.match(r.paypal_order_id, /^MOCK-ORDER-/);
      return say("Bought the tackle box for $34.99.");
    },
  ]);
  _setClientForTests(client);
  const out = await chat("Get my dad a fishing gift under $60");
  assert.equal(out.text, "Bought the tackle box for $34.99.");
  assert.ok(found.length > 0);
  assert.deepEqual(out.events.map((e) => e.type), ["products", "purchase"]);
  assert.equal(store.getState().purchases[0].status, "paid");
  // The fallback beta is sent and the conversation alternates correctly.
  assert.equal(client.calls[0].fallbacks, "default");
  assert.deepEqual(client.calls[2].messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
});

test("over the auto limit becomes a pending approval, blocked items are denied, unknown ids rejected", async () => {
  resetConversation();
  const client = scripted([
    () => toolUse("a", "search_products", { query: "burr coffee grinder" }),
    (p) => toolUse("b", "buy_product", { product_id: lastToolResult(p).results[0].product_id, reason: "Office coffee." }),
    (p) => {
      const r = lastToolResult(p);
      assert.equal(r.status, "awaiting_approval");
      assert.match(r.reasons.join(" "), /auto-approve/);
      return toolUse("c", "search_products", { query: "gift card" });
    },
    (p) => toolUse("d", "buy_product", { product_id: lastToolResult(p).results[0].product_id, reason: "x" }),
    (p) => {
      assert.equal(lastToolResult(p).status, "denied");
      return toolUse("e", "buy_product", { product_id: "made_up", reason: "x" });
    },
    (p) => {
      const last = p.messages.at(-1).content[0];
      assert.equal(last.is_error, true);
      return say("Done.");
    },
  ]);
  _setClientForTests(client);
  await chat("grinder and a gift card");
  const [denied, pending] = store.getState().purchases;
  assert.equal(denied.status, "denied");
  assert.equal(pending.status, "awaiting_approval");

  const { startApproval, completeApproval, refundPurchase } = await import("../src/purchases.js");
  const orderId = await startApproval(pending.id);
  const paid = await completeApproval(pending.id, orderId);
  assert.equal(paid.status, "paid");
  assert.equal(paid.approvedBy, "human");
  const refunded = await refundPurchase(paid.id);
  assert.equal(refunded.status, "refunded");
});

test("an API error rolls back the half-finished turn", async () => {
  resetConversation();
  _setClientForTests(scripted([() => toolUse("z", "search_products", { query: "pens" }), () => { throw new Error("boom"); }]));
  await assert.rejects(chat("pens please"), /boom/);
  assert.equal(store.getState().conversation.length, 0);
});
