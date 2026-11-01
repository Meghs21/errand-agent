import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMandate, sanitizeCart, sanitizeMandateInput } from "../src/policy.js";

const now = new Date("2026-11-01T12:00:00Z");
const mandate = (over = {}) => ({
  id: "m1",
  status: "active",
  ...sanitizeMandateInput({ agentName: "Errand", purpose: "Birthday gifts for my dad", perPurchaseLimit: 80, autoApproveLimit: 40, totalLimit: 150 }, now),
  ...over,
});
const cart = (price, name = "Tackle box", merchant = "rei.com", quantity = 1) => sanitizeCart({ merchant, items: [{ name, unit_price: price, quantity }] });
const run = (m, c, payments = [], walletLinked = true) => checkMandate({ mandate: m, ...c, payments, walletLinked, now });
const failed = (r) => r.checks.filter((c) => !c.pass).map((c) => c.name);

test("a normal cart passes every check", () => {
  const r = run(mandate(), cart(34.99));
  assert.equal(r.pass, true);
  assert.deepEqual(failed(r), []);
});

test("cart totals use integer cents", () => {
  assert.equal(sanitizeCart({ merchant: "x.com", items: [{ name: "a", unit_price: 0.1, quantity: 3 }] }).amount, 0.3);
});

test("per-purchase and total limits", () => {
  assert.deepEqual(failed(run(mandate(), cart(81))), ["per_purchase_limit"]);
  const prior = [{ mandateId: "m1", amount: 120, status: "captured", createdAt: "2026-10-20T00:00:00Z" }];
  assert.deepEqual(failed(run(mandate(), cart(40), prior)), ["total_limit"]);
  // held and in-flight payments count; rejected/declined/refunded don't
  const mixed = ["held", "processing", "declined", "refunded", "rejected"].map((status) => ({ mandateId: "m1", amount: 50, status, createdAt: "2026-10-20T00:00:00Z" }));
  assert.deepEqual(failed(run(mandate(), cart(60), mixed)), ["total_limit"]);
  assert.equal(run(mandate(), cart(50), mixed).pass, true);
});

test("revoked, expired, no wallet", () => {
  assert.deepEqual(failed(run(mandate({ status: "revoked" }), cart(10))), ["mandate_active"]);
  assert.deepEqual(failed(run(mandate({ expiresAt: "2026-10-31T00:00:00Z" }), cart(10))), ["not_expired"]);
  assert.deepEqual(failed(run(mandate(), cart(10), [], false)), ["wallet_linked"]);
});

test("velocity limit counts the last 24 hours, not rejected requests", () => {
  const recent = Array.from({ length: 5 }, () => ({ mandateId: "m1", amount: 1, status: "captured", createdAt: "2026-11-01T08:00:00Z" }));
  assert.deepEqual(failed(run(mandate({ totalLimit: 1000 }), cart(1), recent)), ["velocity"]);
  const rejected = recent.map((p) => ({ ...p, status: "rejected" }));
  assert.equal(run(mandate(), cart(1), rejected).pass, true);
});

test("blocked keywords and merchant allowlist", () => {
  assert.deepEqual(failed(run(mandate(), cart(50, "$50 Digital Gift Card"))), ["blocked_keywords"]);
  const m = mandate({ allowedMerchants: ["rei.com"] });
  assert.equal(run(m, cart(10, "Hat", "www.rei.com")).pass, true);
  assert.deepEqual(failed(run(m, cart(10, "Hat", "evil-rei.com"))), ["merchant_allowed"]);
});

test("bad carts are rejected before any check", () => {
  assert.throws(() => sanitizeCart({ items: [] }), /merchant/);
  assert.throws(() => sanitizeCart({ merchant: "x.com", items: [{ name: "a", unit_price: -1 }] }), /unit_price/);
  assert.throws(() => sanitizeCart({ merchant: "x.com", items: [{ name: "a", unit_price: 1, quantity: 1.5 }] }), /quantity/);
  assert.throws(() => sanitizeCart({ merchant: "x.com", currency: "EUR", items: [{ name: "a", unit_price: 1 }] }), /USD/);
});

test("mandate input clamps limits so auto <= per-purchase <= total", () => {
  const m = sanitizeMandateInput({ agentName: "A", purpose: "Office supplies", totalLimit: 30, perPurchaseLimit: 50, autoApproveLimit: 90 }, now);
  assert.equal(m.perPurchaseLimit, 30);
  assert.equal(m.autoApproveLimit, 30);
  assert.throws(() => sanitizeMandateInput({ agentName: "", purpose: "x" }), /name/);
});
