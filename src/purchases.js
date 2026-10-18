// Turns "the agent wants to buy X" into money movement, with the policy in
// front of every PayPal call. Shared by the agent's buy tool and the HTTP
// routes the approval button and refund button use.
import * as paypal from "./paypal.js";
import { evaluatePurchase, spentThisMonth, round2 } from "./policy.js";
import { getState, createPurchase, updatePurchase, findPurchase } from "./store.js";

export async function attemptPurchase({ productId, reason }) {
  const state = getState();
  const product = state.products[productId];
  if (!product) {
    return { ok: false, error: `Unknown product_id "${productId}". Only products returned by search_products can be bought.` };
  }

  const verdict = evaluatePurchase({
    product,
    rules: state.rules,
    purchases: state.purchases,
    walletLinked: Boolean(state.wallet?.vaultId),
  });
  const purchase = createPurchase({ product, reason, decision: verdict.decision, reasons: verdict.reasons });

  if (verdict.decision !== "auto") return { ok: true, purchase };

  try {
    const result = await paypal.chargeVaultedWallet(purchase, state.wallet.vaultId);
    const paid = result.status === "COMPLETED";
    return {
      ok: true,
      purchase: updatePurchase(purchase.id, {
        status: paid ? "paid" : "failed",
        paypalOrderId: result.orderId,
        captureId: result.captureId,
        error: paid ? null : `PayPal order status ${result.status}`,
      }),
    };
  } catch (err) {
    return { ok: true, purchase: updatePurchase(purchase.id, { status: "failed", error: err.message }) };
  }
}

/** Human tapped "Approve with PayPal": create the order the popup will show. */
export async function startApproval(purchaseId) {
  const purchase = findPurchase(purchaseId);
  if (!purchase || purchase.status !== "awaiting_approval") throw new Error("This purchase is not waiting for approval.");
  const order = await paypal.createOrderForApproval(purchase);
  updatePurchase(purchase.id, { paypalOrderId: order.id });
  return order.id;
}

/** Popup approved: capture the money. */
export async function completeApproval(purchaseId, orderId) {
  const purchase = findPurchase(purchaseId);
  if (!purchase || purchase.status !== "awaiting_approval") throw new Error("This purchase is not waiting for approval.");
  if (purchase.paypalOrderId !== orderId) throw new Error("Order does not match this purchase.");
  const result = await paypal.captureOrder(orderId);
  const paid = result.status === "COMPLETED";
  return updatePurchase(purchase.id, {
    status: paid ? "paid" : "failed",
    captureId: result.captureId,
    approvedBy: "human",
    error: paid ? null : `PayPal order status ${result.status}`,
  });
}

export function declinePurchase(purchaseId) {
  const purchase = findPurchase(purchaseId);
  if (!purchase || purchase.status !== "awaiting_approval") throw new Error("This purchase is not waiting for approval.");
  return updatePurchase(purchase.id, { status: "declined" });
}

export async function refundPurchase(purchaseId) {
  const purchase = findPurchase(purchaseId);
  if (!purchase || purchase.status !== "paid" || !purchase.captureId) throw new Error("Only paid purchases can be refunded.");
  const refund = await paypal.refundCapture(purchase.captureId);
  return updatePurchase(purchase.id, { status: "refunded", refundId: refund.id });
}

export function spendingStatus() {
  const { rules, purchases, wallet } = getState();
  const spent = spentThisMonth(purchases);
  return {
    rules,
    spentThisMonth: spent,
    remainingThisMonth: round2(rules.monthlyBudget - spent),
    walletLinked: Boolean(wallet?.vaultId),
    recentPurchases: purchases.slice(0, 8).map((p) => ({
      title: p.title,
      amount: p.amount,
      status: p.status,
      createdAt: p.createdAt,
    })),
  };
}
