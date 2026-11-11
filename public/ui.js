// Shared front-end helpers. No framework, no build step.

export const $ = (id) => document.getElementById(id);
export const money = (n) => `$${Number(n).toFixed(2)}`;

// Build DOM nodes with textContent only, so agent and retailer text can never inject HTML.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

export function toast(text, isError = false) {
  const t = el("div", { class: `toast ${isError ? "error" : ""}` }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

export function renderPills(config, target) {
  const pills = [
    [config.aiReady ? `${config.aiName || "Claude"} connected` : `${config.aiName || "Claude"}: add API key`, config.aiReady],
    [config.paypalMock ? "PayPal: simulated" : "PayPal sandbox", !config.paypalMock],
    [config.catalog === "channel3" ? "Channel3 catalog" : "Demo catalog", config.catalog === "channel3"],
  ];
  target.replaceChildren(...pills.map(([t, on]) => el("span", { class: `pill ${on ? "on" : "off"}` }, t)));
}

export const STATUS_LABEL = {
  captured: "Paid",
  held: "On hold: needs your OK",
  rejected: "Blocked",
  declined: "Declined, hold released",
  refunded: "Refunded",
  failed: "Payment failed",
  processing: "Checking…",
};

export const ago = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
