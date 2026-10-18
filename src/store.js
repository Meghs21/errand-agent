// Tiny JSON-file store. One household, one agent: enough for a demo, and
// nothing to install. State survives restarts in data/state.json.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RULES } from "./policy.js";

const FILE = process.env.STATE_FILE || path.resolve("data", "state.json");

function fresh() {
  return {
    rules: { ...DEFAULT_RULES },
    wallet: null, // { vaultId, customerId, email, linkedAt }
    purchases: [], // see createPurchase()
    products: {}, // product cache keyed by id, so the agent can only buy things it actually found
    conversation: [], // Anthropic message history
  };
}

let state = load();

function load() {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return fresh();
  }
}

export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function getState() {
  return state;
}

export function reset({ keepWallet = true } = {}) {
  const wallet = state.wallet;
  state = fresh();
  if (keepWallet) state.wallet = wallet;
  save();
}

export function cacheProducts(products) {
  for (const p of products) state.products[p.id] = p;
  save();
}

export function createPurchase({ product, reason, decision, reasons }) {
  const purchase = {
    id: `pur_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    productId: product.id,
    title: product.title,
    brand: product.brand,
    image: product.image,
    merchant: product.merchant,
    url: product.url,
    amount: product.price,
    currency: product.currency || "USD",
    reason,
    decision,
    reasons,
    status: decision === "denied" ? "denied" : decision === "auto" ? "processing" : "awaiting_approval",
    paypalOrderId: null,
    captureId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.purchases.unshift(purchase);
  save();
  return purchase;
}

export function updatePurchase(id, patch) {
  const p = state.purchases.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  save();
  return p;
}

export function findPurchase(id) {
  return state.purchases.find((x) => x.id === id) || null;
}
