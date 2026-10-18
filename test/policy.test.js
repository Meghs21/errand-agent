import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePurchase, sanitizeRules, DEFAULT_RULES } from "../src/policy.js";

const rules = { ...DEFAULT_RULES, monthlyBudget: 100, autoApproveLimit: 40 };
const product = (price, title = "Tackle box") => ({ id: "x", title, price });
const now = new Date("2026-10-18T12:00:00Z");
const paid = (amount, createdAt = "2026-10-02T00:00:00Z", status = "paid") => ({ amount, createdAt, status });

test("small purchase with a linked wallet goes through on its own", () => {
  const r = evaluatePurchase({ product: product(25), rules, purchases: [], walletLinked: true, now });
  assert.equal(r.decision, "auto");
});

test("purchase above the auto-approve limit needs a human", () => {
  const r = evaluatePurchase({ product: product(59), rules, purchases: [], walletLinked: true, now });
  assert.equal(r.decision, "needs_approval");
  assert.match(r.reasons[0], /auto-approve/);
});

test("no linked wallet means every purchase needs a human", () => {
  const r = evaluatePurchase({ product: product(10), rules, purchases: [], walletLinked: false, now });
  assert.equal(r.decision, "needs_approval");
});

test("blocked keywords are denied regardless of price", () => {
  const r = evaluatePurchase({ product: product(5, "$50 Digital Gift Card"), rules, purchases: [], walletLinked: true, now });
  assert.equal(r.decision, "denied");
});

test("monthly budget counts paid and pending purchases this month only", () => {
  const purchases = [paid(50), paid(30, "2026-10-05T00:00:00Z", "awaiting_approval"), paid(90, "2026-09-30T00:00:00Z"), paid(40, "2026-10-06T00:00:00Z", "refunded")];
  const r = evaluatePurchase({ product: product(25), rules, purchases, walletLinked: true, now });
  assert.equal(r.decision, "denied");
  assert.match(r.reasons[0], /\$20\.00 left/);
  const ok = evaluatePurchase({ product: product(20), rules, purchases, walletLinked: true, now });
  assert.equal(ok.decision, "auto");
});

test("sanitizeRules clamps the auto limit to the budget and cleans keywords", () => {
  const r = sanitizeRules({ monthlyBudget: "30", autoApproveLimit: 80, blockedKeywords: [" Vape ", "", "beer"] });
  assert.equal(r.monthlyBudget, 30);
  assert.equal(r.autoApproveLimit, 30);
  assert.deepEqual(r.blockedKeywords, ["vape", "beer"]);
  assert.equal(sanitizeRules({ monthlyBudget: -5 }).monthlyBudget, DEFAULT_RULES.monthlyBudget);
});
