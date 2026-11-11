// Tiny JSON-file store: one owner, their PayPal wallet, the mandates they've
// issued, and every payment request agents have made. Enough for a prototype,
// nothing to install. State survives restarts in data/state.json.
import fs from "node:fs";
import path from "node:path";

const FILE = process.env.STATE_FILE || path.resolve("data", "state.json");

function fresh() {
  return {
    wallet: null, // { vaultId, customerId, email, linkedAt }
    mandates: [], // see mandates.js
    payments: [], // see payments.js, newest first
    demo: { products: {}, conversation: [] }, // state for the Errand demo agent
  };
}

let state = load();

function load() {
  let s;
  try {
    s = { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    s = fresh();
  }
  // Hosted demos lose their disk on restart. A saved PayPal wallet id in the
  // environment keeps the demo wallet linked anyway.
  if (!s.wallet && process.env.PAYPAL_DEMO_VAULT_ID) s.wallet = envWallet();
  return s;
}

function envWallet() {
  return {
    vaultId: process.env.PAYPAL_DEMO_VAULT_ID,
    customerId: null,
    email: process.env.PAYPAL_DEMO_EMAIL || "PayPal sandbox buyer",
    linkedAt: new Date().toISOString(),
    fromEnv: true,
  };
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

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
