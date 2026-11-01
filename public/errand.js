// Errand demo agent UI. The page holds a mandate token (like any agent would)
// and shows what AgentPass decided for each payment.
import { $, el, api, money, toast, renderPills, STATUS_LABEL } from "/ui.js";

const SUGGESTIONS = [
  ["Get my dad a birthday present, he loves fishing. Keep it under $40.", "Fits the mandate and the auto-approve limit, so it's paid right away"],
  ["Also get him the burr coffee grinder.", "Over the auto-approve limit: PayPal holds the funds until the owner approves"],
  ["Grab 5 reams of printer paper for my office too.", "Within limits, but the AI intent check sees it isn't a gift for dad"],
  ["Get him a $50 gift card.", "Gift cards are blocked for this agent"],
];

let token = "";

function readToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    history.replaceState(null, "", location.pathname); // don't leave the token in the address bar
    return fromHash;
  }
  try {
    return localStorage.getItem("errand.token") || "";
  } catch {
    return "";
  }
}

async function setToken(t) {
  token = t.trim();
  $("token").value = token;
  try {
    localStorage.setItem("errand.token", token);
  } catch {}
  await renderMandate();
}

async function renderMandate() {
  const box = $("mandate");
  if (!token) return;
  try {
    const res = await fetch("/v1/mandate", { headers: { Authorization: `Bearer ${token}` } });
    const m = await res.json();
    if (!res.ok) throw new Error(m.error);
    box.replaceChildren(
      el("div", { class: "row card-head" }, el("b", {}, m.agent_name), el("span", { class: `badge ${m.status === "active" ? "captured" : "rejected"}` }, m.status)),
      el("p", { class: "hint" }, `“${m.purpose}”`),
      el("div", { class: "meter-bar" }, el("span", { style: `width:${Math.min(100, ((m.total_limit - m.remaining) / m.total_limit) * 100)}%` })),
      el("p", { class: "hint" }, `${money(m.remaining)} left of ${money(m.total_limit)} · ${money(m.per_purchase_limit)} per purchase · pays on its own up to ${money(m.auto_approve_limit)}`),
    );
  } catch (err) {
    box.replaceChildren(el("p", { class: "hint" }, `Token not accepted: ${err.message}`));
  }
}

$("tokenbar").addEventListener("submit", (e) => {
  e.preventDefault();
  setToken($("token").value);
});

// --- Chat -------------------------------------------------------------------------------

function welcome() {
  return el(
    "div",
    { class: "welcome", id: "welcome" },
    el("h2", {}, "What do you need picked up?"),
    el("p", {}, "Try these in order with the Errand demo mandate from the dashboard (“Birthday gifts for my dad”)."),
    el(
      "div",
      { class: "suggestions" },
      SUGGESTIONS.map(([text, sub]) => el("button", { type: "button", onclick: () => send(text) }, text, el("small", {}, sub))),
    ),
  );
}

function addToChat(node) {
  $("welcome")?.remove();
  $("messages").append(node);
  node.scrollIntoView({ behavior: "smooth", block: "end" });
  return node;
}

function productCard(p) {
  const img = p.image ? el("img", { src: p.image, alt: "", loading: "lazy" }) : p.emoji || "🛍️";
  return el(
    "a",
    { class: "product", href: p.url, target: "_blank", rel: "noopener noreferrer" },
    el("div", { class: "img" }, img),
    el(
      "div",
      { class: "body" },
      el("div", { class: "title", title: p.title }, p.title),
      el("div", { class: "price" }, money(p.price)),
      el("div", { class: "merchant" }, p.brand ? `${p.brand} · ${p.merchant}` : p.merchant),
    ),
  );
}

function paymentCard(p) {
  return el(
    "div",
    { class: `pay ${p.status}` },
    el("div", { class: "row" }, el("span", { class: "items" }, p.title), el("span", { class: `badge ${p.status}` }, STATUS_LABEL[p.status] || p.status)),
    el("div", { class: "row" }, el("span", { class: "who" }, `AgentPass → ${p.merchant}`), el("span", { class: "amount" }, money(p.amount))),
    p.status !== "captured" && p.reasons?.length ? el("ul", { class: "reasons" }, p.reasons.map((r) => el("li", {}, r))) : null,
    p.status === "held" ? el("a", { class: "nav-link", href: "/", target: "_blank" }, "Approve in the AgentPass dashboard ↗") : null,
    p.paypal_order_id ? el("div", { class: "ids" }, `PayPal order ${p.paypal_order_id} · ${p.payment_id}`) : null,
  );
}

let busy = false;
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  if (!token) return toast("Paste a mandate token first.", true);
  busy = true;
  $("send").disabled = true;
  $("input").value = "";
  addToChat(el("div", { class: "msg user" }, text));
  const typing = addToChat(el("div", { class: "typing" }, "Errand is working on it"));
  try {
    const r = await api("/api/errand/chat", { method: "POST", body: { message: text, token } });
    typing.remove();
    for (const e of r.events) {
      if (e.type === "products" && e.products.length) {
        addToChat(el("div", { class: "products" }, el("div", { class: "label" }, `Searched "${e.query}"`), el("div", { class: "product-row" }, e.products.map(productCard))));
      }
    }
    addToChat(el("div", { class: "msg agent" }, r.text));
    for (const e of r.events) if (e.type === "payment") addToChat(paymentCard(e.payment));
    renderMandate();
  } catch (err) {
    typing.remove();
    addToChat(el("div", { class: "msg error" }, `Something went wrong: ${err.message}`));
  } finally {
    busy = false;
    $("send").disabled = false;
    $("input").focus();
  }
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("input").value);
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send($("input").value);
  }
});

async function newErrand() {
  await api("/api/errand/reset", { method: "POST" });
  $("messages").replaceChildren(welcome());
}
$("new-errand").addEventListener("click", newErrand);

(async function boot() {
  renderPills(await api("/api/config"), $("pills"));
  await newErrand();
  await setToken(readToken());
})();
