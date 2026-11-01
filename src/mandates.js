// Mandates: a scoped, revocable permission for one agent to spend from the
// owner's PayPal wallet. The agent holds a bearer token; we store only its
// SHA-256 hash, so a leaked state file can't be used to pay.
import crypto from "node:crypto";
import { sanitizeMandateInput, committed, round2 } from "./policy.js";
import { getState, save, newId } from "./store.js";

const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** Create a mandate. Returns { mandate, token }; the token is shown once. */
export function createMandate(input) {
  const fields = sanitizeMandateInput(input);
  const token = `apm_${crypto.randomBytes(24).toString("base64url")}`;
  const mandate = {
    id: newId("mnd"),
    ...fields,
    status: "active",
    tokenHash: hash(token),
    tokenHint: `${token.slice(0, 8)}…${token.slice(-4)}`,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  getState().mandates.unshift(mandate);
  save();
  return { mandate: publicMandate(mandate), token };
}

export function revokeMandate(id) {
  const m = getState().mandates.find((x) => x.id === id);
  if (!m) throw Object.assign(new Error("No such mandate."), { status: 404 });
  if (m.status === "active") {
    m.status = "revoked";
    m.revokedAt = new Date().toISOString();
    save();
  }
  return publicMandate(m);
}

/** Look up the mandate for a bearer token. Returns null if unknown. */
export function mandateForToken(token) {
  if (typeof token !== "string" || !token.startsWith("apm_")) return null;
  const h = Buffer.from(hash(token), "hex");
  return getState().mandates.find((m) => crypto.timingSafeEqual(Buffer.from(m.tokenHash, "hex"), h)) || null;
}

export function findMandate(id) {
  return getState().mandates.find((m) => m.id === id) || null;
}

/** What a mandate looks like outside the server: no token hash, plus live usage. */
export function publicMandate(m) {
  const { tokenHash, ...rest } = m;
  const used = committed(getState().payments, m.id);
  const expired = new Date(m.expiresAt) <= new Date();
  return {
    ...rest,
    status: m.status === "active" && expired ? "expired" : m.status,
    used,
    remaining: round2(Math.max(0, m.totalLimit - used)),
  };
}

export function listMandates() {
  return getState().mandates.map(publicMandate);
}
