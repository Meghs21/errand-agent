// Deterministic mandate checks. These run before the AI intent check and
// before any PayPal call, and a failure here can't be overridden by anything
// the agent says. Pure functions, so they're easy to test.

export const DEFAULT_BLOCKED = ["alcohol", "tobacco", "vape", "gift card", "firearm", "crypto"];

export function round2(n) {
  return Math.round(n * 100) / 100;
}

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? round2(Number(v)) : fallback);

/** Normalize a mandate request from the dashboard. Throws on missing essentials. */
export function sanitizeMandateInput(input = {}, now = new Date()) {
  const agentName = String(input.agentName || "").trim().slice(0, 60);
  const purpose = String(input.purpose || "").trim().slice(0, 500);
  if (!agentName) throw badRequest("Give the agent a name.");
  if (purpose.length < 8) throw badRequest("Describe what the agent may buy, in a sentence.");

  const totalLimit = num(input.totalLimit, 100);
  const perPurchaseLimit = Math.min(num(input.perPurchaseLimit, 50), totalLimit);
  const autoApproveLimit = Math.min(num(input.autoApproveLimit, 25), perPurchaseLimit);
  const days = Math.max(1, Math.min(365, Math.round(num(input.expiresInDays, 30))));
  const maxPaymentsPerDay = Math.max(1, Math.min(100, Math.round(num(input.maxPaymentsPerDay, 5))));
  const list = (v, fallback) =>
    Array.isArray(v) || typeof v === "string"
      ? (Array.isArray(v) ? v : v.split(","))
          .map((k) => String(k).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 50)
      : fallback;

  return {
    agentName,
    purpose,
    totalLimit,
    perPurchaseLimit,
    autoApproveLimit,
    maxPaymentsPerDay,
    blockedKeywords: list(input.blockedKeywords, [...DEFAULT_BLOCKED]),
    allowedMerchants: list(input.allowedMerchants, []),
    currency: "USD",
    expiresAt: new Date(now.getTime() + days * 86400_000).toISOString(),
  };
}

/** Validate and price a cart sent by an agent. Returns { cart, amount } or throws. */
export function sanitizeCart(input = {}) {
  const merchant = String(input.merchant || "").trim().toLowerCase().slice(0, 120);
  if (!merchant) throw badRequest("cart.merchant is required.");
  if (!Array.isArray(input.items) || input.items.length === 0) throw badRequest("cart.items must be a non-empty array.");
  if (input.items.length > 20) throw badRequest("At most 20 items per payment.");
  if (input.currency && input.currency !== "USD") throw badRequest("Only USD is supported.");

  let cents = 0;
  const items = input.items.map((i, idx) => {
    const name = String(i?.name || "").trim().slice(0, 127);
    const unit = Number(i?.unit_price);
    const quantity = Number(i?.quantity ?? 1);
    if (!name) throw badRequest(`items[${idx}].name is required.`);
    if (!(unit > 0) || unit > 100000) throw badRequest(`items[${idx}].unit_price must be a positive number.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw badRequest(`items[${idx}].quantity must be 1-99.`);
    cents += Math.round(unit * 100) * quantity;
    return {
      name,
      unit_price: round2(unit),
      quantity,
      category: i.category ? String(i.category).slice(0, 60) : null,
      url: i.url ? String(i.url).slice(0, 500) : null,
    };
  });
  return {
    cart: {
      merchant,
      items,
      currency: "USD",
      description: String(input.description || "").trim().slice(0, 500),
    },
    amount: cents / 100,
  };
}

/** Money already committed under a mandate: captured, held, or mid-flight. */
export function committed(payments, mandateId) {
  return round2(
    payments.filter((p) => p.mandateId === mandateId && ["captured", "held", "processing"].includes(p.status)).reduce((s, p) => s + p.amount, 0),
  );
}

/**
 * Run every hard rule. Returns { pass, checks: [{ name, pass, detail }] }.
 * All checks run (no short-circuit) so the audit log shows the full picture.
 */
export function checkMandate({ mandate, cart, amount, payments, walletLinked, now = new Date() }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add("mandate_active", mandate.status === "active", mandate.status === "active" ? "Mandate is active" : `Mandate is ${mandate.status}`);
  const expired = new Date(mandate.expiresAt) <= now;
  add("not_expired", !expired, expired ? `Expired ${mandate.expiresAt.slice(0, 10)}` : `Valid until ${mandate.expiresAt.slice(0, 10)}`);
  add("wallet_linked", walletLinked, walletLinked ? "PayPal wallet on file" : "Owner has no PayPal wallet linked");

  add(
    "per_purchase_limit",
    amount <= mandate.perPurchaseLimit,
    `$${amount.toFixed(2)} vs $${mandate.perPurchaseLimit.toFixed(2)} per-purchase limit`,
  );

  const used = committed(payments, mandate.id);
  const left = round2(mandate.totalLimit - used);
  add("total_limit", amount <= left, `$${amount.toFixed(2)} vs $${left.toFixed(2)} left of $${mandate.totalLimit.toFixed(2)}`);

  const dayAgo = now.getTime() - 86400_000;
  const recent = payments.filter((p) => p.mandateId === mandate.id && p.status !== "rejected" && new Date(p.createdAt).getTime() > dayAgo).length;
  add("velocity", recent < mandate.maxPaymentsPerDay, `${recent} of ${mandate.maxPaymentsPerDay} payments in the last 24h`);

  const text = `${cart.merchant} ${cart.items.map((i) => `${i.name} ${i.category ?? ""}`).join(" ")}`.toLowerCase();
  const hit = mandate.blockedKeywords.find((k) => text.includes(k));
  add("blocked_keywords", !hit, hit ? `"${hit}" is blocked for this agent` : "No blocked items");

  if (mandate.allowedMerchants.length) {
    const ok = mandate.allowedMerchants.some((m) => cart.merchant === m || cart.merchant.endsWith(`.${m}`));
    add("merchant_allowed", ok, ok ? `${cart.merchant} is allowed` : `${cart.merchant} is not on the allowed list`);
  }

  return { pass: checks.every((c) => c.pass), checks };
}

export const SPLIT_WINDOW_MINUTES = 15;

/**
 * Soft signals that don't block a payment but route it to the owner.
 * Today: split purchases, where an agent breaks one buy into several small
 * payments at the same merchant to stay under the auto-approve limit.
 */
export function reviewFlags({ mandate, cart, amount, payments, now = new Date() }) {
  const flags = [];
  const since = now.getTime() - SPLIT_WINDOW_MINUTES * 60_000;
  const recent = payments.filter(
    (p) =>
      p.mandateId === mandate.id &&
      p.merchant === cart.merchant &&
      ["captured", "held", "processing"].includes(p.status) &&
      new Date(p.createdAt).getTime() > since,
  );
  const combined = round2(recent.reduce((s, p) => s + p.amount, 0) + amount);
  if (recent.length && amount <= mandate.autoApproveLimit && combined > mandate.autoApproveLimit) {
    flags.push(
      `Possible split purchase: $${combined.toFixed(2)} at ${cart.merchant} across ${recent.length + 1} payments in ${SPLIT_WINDOW_MINUTES} minutes, over the $${mandate.autoApproveLimit.toFixed(2)} auto-approve limit`,
    );
  }
  return flags;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
