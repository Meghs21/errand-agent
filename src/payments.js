// The payment pipeline every agent request goes through:
//   1. hard mandate checks (policy.js)       -> reject on any failure
//   2. AI intent check (verifier.js)          -> reject / hold / allow
//   3. PayPal: capture now (small, approved) or authorize-and-hold (owner decides)
// Each request is recorded with its checks and verdict, so the owner can see
// exactly why money did or didn't move.
import * as paypal from "./paypal.js";
import { checkMandate, sanitizeCart } from "./policy.js";
import { verifyIntent } from "./verifier.js";
import { findMandate } from "./mandates.js";
import { getState, save, newId } from "./store.js";

export async function requestPayment({ mandate, cartInput, idempotencyKey }) {
  const state = getState();

  // Same key from the same agent returns the original result instead of paying twice.
  if (idempotencyKey) {
    const prior = state.payments.find((p) => p.mandateId === mandate.id && p.idempotencyKey === idempotencyKey);
    if (prior) return prior;
  }

  const { cart, amount } = sanitizeCart(cartInput);
  const now = new Date();
  const payment = {
    id: newId("pay"),
    mandateId: mandate.id,
    agentName: mandate.agentName,
    idempotencyKey: idempotencyKey || null,
    merchant: cart.merchant,
    items: cart.items,
    description: cart.description,
    currency: cart.currency,
    amount,
    checks: [],
    verdict: null,
    route: null, // "capture" | "hold" | "reject"
    status: "processing",
    reasons: [],
    paypal: { orderId: null, authorizationId: null, captureId: null, refundId: null },
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const hard = checkMandate({ mandate, cart, amount, payments: state.payments, walletLinked: Boolean(state.wallet?.vaultId), now });
  payment.checks = hard.checks;
  // Record the request before any slow call so concurrent requests count against limits.
  state.payments.unshift(payment);
  save();

  if (!hard.pass) {
    return finish(payment, { route: "reject", status: "rejected", reasons: hard.checks.filter((c) => !c.pass).map((c) => c.detail) });
  }

  payment.verdict = await verifyIntent({ mandate, cart, amount });
  if (payment.verdict.decision === "reject") {
    return finish(payment, { route: "reject", status: "rejected", reasons: payment.verdict.reasons });
  }

  const overAuto = amount > mandate.autoApproveLimit;
  const hold = overAuto || payment.verdict.decision === "needs_review";
  const reasons = [];
  if (overAuto) reasons.push(`$${amount.toFixed(2)} is above this agent's $${mandate.autoApproveLimit.toFixed(2)} auto-approve limit`);
  if (payment.verdict.decision === "needs_review") reasons.push(...payment.verdict.reasons);

  try {
    if (hold) {
      const r = await paypal.authorizeVaultedWallet(payment, state.wallet.vaultId);
      if (r.status !== "COMPLETED" || !r.authorizationId) throw new Error(`PayPal hold status ${r.status}`);
      return finish(payment, {
        route: "hold",
        status: "held",
        reasons,
        paypal: { ...payment.paypal, orderId: r.orderId, authorizationId: r.authorizationId },
      });
    }
    const r = await paypal.chargeVaultedWallet(payment, state.wallet.vaultId);
    if (r.status !== "COMPLETED") throw new Error(`PayPal order status ${r.status}`);
    return finish(payment, {
      route: "capture",
      status: "captured",
      reasons: ["Within limits and matches the mandate"],
      paypal: { ...payment.paypal, orderId: r.orderId, captureId: r.captureId },
    });
  } catch (err) {
    return finish(payment, { route: hold ? "hold" : "capture", status: "failed", error: err.message, reasons: ["PayPal didn't accept the payment"] });
  }
}

function finish(payment, patch) {
  Object.assign(payment, patch, { updatedAt: new Date().toISOString() });
  save();
  return payment;
}

function findPayment(id) {
  const p = getState().payments.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error("No such payment."), { status: 404 });
  return p;
}

/** Owner approves a held payment: capture the authorization. */
export async function approvePayment(id) {
  const p = findPayment(id);
  if (p.status !== "held") throw Object.assign(new Error("This payment isn't waiting for approval."), { status: 409 });
  const m = findMandate(p.mandateId);
  if (!m || m.status !== "active") {
    // Revoking a mandate means nothing more goes out under it, held payments included.
    await paypal.voidAuthorization(p.paypal.authorizationId).catch(() => {});
    finish(p, { status: "declined", reasons: [...p.reasons, "Mandate was revoked before approval"] });
    throw Object.assign(new Error("The mandate was revoked, so the hold was released."), { status: 409 });
  }
  const r = await paypal.captureAuthorization(p.paypal.authorizationId);
  return finish(p, { status: "captured", approvedBy: "owner", paypal: { ...p.paypal, captureId: r.captureId } });
}

/** Owner declines a held payment: void the authorization, funds are released. */
export async function declinePayment(id) {
  const p = findPayment(id);
  if (p.status !== "held") throw Object.assign(new Error("This payment isn't waiting for approval."), { status: 409 });
  await paypal.voidAuthorization(p.paypal.authorizationId);
  return finish(p, { status: "declined", declinedBy: "owner" });
}

export async function refundPayment(id) {
  const p = findPayment(id);
  if (p.status !== "captured" || !p.paypal.captureId) throw Object.assign(new Error("Only captured payments can be refunded."), { status: 409 });
  const r = await paypal.refundCapture(p.paypal.captureId);
  return finish(p, { status: "refunded", paypal: { ...p.paypal, refundId: r.id } });
}

/** Release every hold under a mandate (used when it's revoked). */
export async function releaseHolds(mandateId) {
  for (const p of getState().payments.filter((x) => x.mandateId === mandateId && x.status === "held")) {
    await paypal.voidAuthorization(p.paypal.authorizationId).catch((e) => console.warn("void failed:", e.message));
    finish(p, { status: "declined", reasons: [...p.reasons, "Mandate revoked"] });
  }
}

/** The view of a payment an agent gets back. No other agents' data, no internals. */
export function agentView(p) {
  return {
    payment_id: p.id,
    status: p.status, // captured | held | rejected | declined | refunded | failed
    amount: p.amount,
    currency: p.currency,
    merchant: p.merchant,
    reasons: p.reasons,
    paypal_order_id: p.paypal.orderId,
    message:
      {
        captured: "Paid.",
        held: "Funds are on hold. The owner must approve before the payment completes. Check back with the payment status call.",
        rejected: "Not allowed under this mandate.",
        declined: "The owner declined this payment. The hold was released.",
        refunded: "Paid, then refunded by the owner.",
        failed: "PayPal did not accept the payment.",
      }[p.status] ?? p.status,
  };
}

export function paymentsForMandate(mandateId) {
  return getState().payments.filter((p) => p.mandateId === mandateId);
}
