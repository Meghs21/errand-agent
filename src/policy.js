// The spending leash. Every purchase the agent attempts goes through
// evaluatePurchase() before any money moves. The agent can read these rules
// but has no tool to change them; only the human can, from the UI.

export const DEFAULT_RULES = {
  monthlyBudget: 200, // hard cap on everything the agent spends in a calendar month
  autoApproveLimit: 40, // purchases at or under this go through without asking
  blockedKeywords: ["alcohol", "tobacco", "vape", "gift card", "firearm"],
  currency: "USD",
};

export function sanitizeRules(input = {}) {
  const rules = { ...DEFAULT_RULES };
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : null);

  if (num(input.monthlyBudget) !== null) rules.monthlyBudget = num(input.monthlyBudget);
  if (num(input.autoApproveLimit) !== null) rules.autoApproveLimit = num(input.autoApproveLimit);
  if (Array.isArray(input.blockedKeywords)) {
    rules.blockedKeywords = input.blockedKeywords
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50);
  }
  rules.autoApproveLimit = Math.min(rules.autoApproveLimit, rules.monthlyBudget);
  return rules;
}

export function spentThisMonth(purchases, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  return round2(
    purchases
      .filter((p) => (p.status === "paid" || p.status === "awaiting_approval") && p.createdAt.slice(0, 7) === month)
      .reduce((sum, p) => sum + p.amount, 0),
  );
}

/**
 * Decide what may happen with a purchase.
 * Returns { decision: "auto" | "needs_approval" | "denied", reasons: string[] }
 */
export function evaluatePurchase({ product, rules, purchases, walletLinked, now = new Date() }) {
  const reasons = [];
  const amount = product.price;
  const haystack = `${product.title} ${product.brand ?? ""} ${product.category ?? ""}`.toLowerCase();

  const hit = rules.blockedKeywords.find((k) => haystack.includes(k));
  if (hit) {
    return { decision: "denied", reasons: [`"${hit}" is on your blocked list`] };
  }

  if (!(amount > 0)) {
    return { decision: "denied", reasons: ["product has no valid price"] };
  }

  const spent = spentThisMonth(purchases, now);
  const remaining = round2(rules.monthlyBudget - spent);
  if (amount > remaining) {
    return {
      decision: "denied",
      reasons: [`$${amount.toFixed(2)} is more than the $${remaining.toFixed(2)} left in this month's $${rules.monthlyBudget} budget`],
    };
  }

  if (amount > rules.autoApproveLimit) {
    reasons.push(`$${amount.toFixed(2)} is above your $${rules.autoApproveLimit} auto-approve limit`);
  }
  if (!walletLinked) {
    reasons.push("no PayPal wallet is linked for hands-free payments yet");
  }

  return reasons.length ? { decision: "needs_approval", reasons } : { decision: "auto", reasons: ["within your rules"] };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}
