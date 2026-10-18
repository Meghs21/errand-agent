// Errand front end: chat with the agent, link a PayPal wallet, set the
// spending leash, approve or refund purchases. No framework, no build step.

const $ = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toFixed(2)}`;

let config = {};
let state = null;
let paypalReady = null; // Promise that resolves when the PayPal JS SDK is loaded

// Build DOM nodes with textContent only, so retailer data can never inject HTML.
function el(tag, attrs = {}, ...children) {
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

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// --- PayPal JS SDK ------------------------------------------------------------

function loadPayPal() {
  if (config.paypalMock) return Promise.resolve(null);
  paypalReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId)}&currency=USD&components=buttons`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error("Could not load PayPal"));
    document.head.append(s);
  });
  return paypalReady;
}

// --- Header pills -------------------------------------------------------------

function renderPills() {
  const pills = [
    [config.aiReady ? "Claude connected" : "Claude: add ANTHROPIC_API_KEY", config.aiReady],
    [config.paypalMock ? "PayPal: simulated" : "PayPal sandbox", !config.paypalMock],
    [config.catalog === "channel3" ? "Channel3 live catalog" : "Demo catalog", config.catalog === "channel3"],
  ];
  $("pills").replaceChildren(...pills.map(([t, on]) => el("span", { class: `pill ${on ? "on" : "off"}` }, t)));
}

// --- Wallet ---------------------------------------------------------------------

async function renderWallet() {
  const box = $("wallet");
  if (state.wallet) {
    box.replaceChildren(
      el(
        "div",
        { class: "wallet-linked" },
        el("div", {}, el("div", { class: "ok" }, "Linked"), el("div", { class: "hint" }, state.wallet.email || "PayPal account")),
        el("button", { class: "danger", onclick: unlinkWallet }, "Unlink"),
      ),
      el("p", { class: "hint" }, `Errand can pay up to ${money(state.rules.autoApproveLimit)} on its own. Anything bigger waits for you.`),
    );
    return;
  }
  const slot = el("div", { id: "vault-button" });
  box.replaceChildren(el("p", { class: "hint" }, "Link PayPal once so Errand can pay for small errands without asking. Nothing is charged now."), slot);

  if (config.paypalMock) {
    slot.append(el("button", { class: "mock", onclick: () => linkWallet("MOCK-SETUP") }, "Link PayPal (simulated)"));
    return;
  }
  try {
    const paypal = await loadPayPal();
    await paypal
      .Buttons({
        style: { label: "paypal", layout: "vertical", height: 40 },
        createVaultSetupToken: async () => (await api("/api/wallet/setup-token", { method: "POST" })).id,
        onApprove: async ({ vaultSetupToken }) => linkWallet(vaultSetupToken),
        onError: (err) => toast(`PayPal error: ${err?.message || err}`),
      })
      .render(slot);
  } catch (err) {
    slot.append(el("p", { class: "hint" }, err.message));
  }
}

async function linkWallet(vaultSetupToken) {
  try {
    state = await api("/api/wallet/link", { method: "POST", body: { vaultSetupToken } });
    renderSide();
    toast("PayPal linked. Errand can now pay within your rules.");
  } catch (err) {
    toast(err.message, true);
  }
}

async function unlinkWallet() {
  state = await api("/api/wallet", { method: "DELETE" });
  renderSide();
}

// --- Rules and budget meter -----------------------------------------------------

function renderRules() {
  const f = $("rules");
  f.monthlyBudget.value = state.rules.monthlyBudget;
  f.autoApproveLimit.value = state.rules.autoApproveLimit;
  f.blockedKeywords.value = state.rules.blockedKeywords.join(", ");

  const pct = state.rules.monthlyBudget ? Math.min(100, (state.spentThisMonth / state.rules.monthlyBudget) * 100) : 100;
  $("meter-fill").style.width = `${pct}%`;
  $("meter-fill").classList.toggle("hot", pct >= 85);
  $("meter-text").textContent = `${money(state.spentThisMonth)} of ${money(state.rules.monthlyBudget)} used this month · ${money(state.remainingThisMonth)} left`;
}

$("rules").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  state = await api("/api/rules", {
    method: "PUT",
    body: {
      monthlyBudget: f.monthlyBudget.value,
      autoApproveLimit: f.autoApproveLimit.value,
      blockedKeywords: f.blockedKeywords.value.split(","),
    },
  });
  renderSide();
  $("rules-saved").hidden = false;
  setTimeout(() => ($("rules-saved").hidden = true), 1500);
});

// --- Activity ---------------------------------------------------------------------

const STATUS_LABEL = {
  paid: "Paid",
  awaiting_approval: "Needs your OK",
  denied: "Blocked by rules",
  declined: "You declined",
  failed: "Payment failed",
  refunded: "Refunded",
  processing: "Paying…",
};

function renderActivity() {
  const list = $("activity");
  if (!state.purchases.length) {
    list.replaceChildren(el("li", { class: "empty" }, "Nothing yet. Purchases show up here with their PayPal IDs."));
    return;
  }
  list.replaceChildren(
    ...state.purchases.slice(0, 20).map((p) =>
      el(
        "li",
        {},
        el("span", { class: "t", title: p.title }, p.title),
        el("span", { class: "amt" }, money(p.amount)),
        el(
          "span",
          { class: "sub" },
          el("span", { class: `badge ${p.status}` }, STATUS_LABEL[p.status] || p.status),
          p.captureId ? el("span", { title: "PayPal capture ID" }, p.captureId) : null,
          p.status === "paid" ? el("button", { class: "danger", onclick: () => refund(p.id) }, "Refund") : null,
        ),
      ),
    ),
  );
}

async function refund(id) {
  if (!confirm("Refund this purchase through PayPal?")) return;
  try {
    const r = await api(`/api/purchases/${id}/refund`, { method: "POST" });
    state = r.state;
    renderSide();
    refreshPurchaseCards(r.purchase);
    toast("Refunded to your PayPal.");
  } catch (err) {
    toast(err.message, true);
  }
}

function renderSide() {
  renderWallet();
  renderRules();
  renderActivity();
}

// --- Chat ---------------------------------------------------------------------------

const SUGGESTIONS = [
  ["Get my dad a birthday gift under $60. He loves fishing.", "Searches, compares, pays on its own if it fits your auto-approve limit"],
  ["We're out of printer paper, can you grab some?", "A routine errand, done in one go"],
  ["Buy the burr coffee grinder for the office.", "Over the auto-approve limit, so it asks you first"],
  ["Get my sister a $50 gift card.", "On the blocked list, so Errand refuses"],
];

function renderSuggestions() {
  $("suggestions").replaceChildren(
    ...SUGGESTIONS.map(([text, sub]) => el("button", { type: "button", onclick: () => send(text) }, text, el("small", {}, sub))),
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

function renderProducts(evt) {
  if (!evt.products.length) return;
  addToChat(
    el(
      "div",
      { class: "products" },
      el("div", { class: "label" }, `Searched "${evt.query}"`),
      el("div", { class: "product-row" }, evt.products.map(productCard)),
    ),
  );
}

function purchaseCard(p) {
  const card = el("div", { class: "purchase", "data-purchase": p.id });
  fillPurchaseCard(card, p);
  return card;
}

function fillPurchaseCard(card, p) {
  const children = [
    el("div", { class: "head" }, el("span", { class: "what" }, `${p.title}`), el("span", { class: `badge ${p.status}` }, STATUS_LABEL[p.status] || p.status)),
    el("div", {}, el("b", {}, money(p.amount)), p.merchant ? ` from ${p.merchant}` : ""),
  ];
  if (p.reason) children.push(el("div", { class: "why" }, `Why: ${p.reason}`));
  if (p.status === "awaiting_approval" || p.status === "denied") {
    children.push(el("ul", { class: "reasons" }, p.reasons.map((r) => el("li", {}, r))));
  }
  if (p.error) children.push(el("div", { class: "why" }, p.error));
  if (p.paypalOrderId && p.status !== "awaiting_approval") {
    children.push(el("div", { class: "meta" }, `PayPal order ${p.paypalOrderId}${p.captureId ? ` · capture ${p.captureId}` : ""}${p.approvedBy === "human" ? " · approved by you" : " · paid by Errand"}`));
  }
  card.replaceChildren(...children);
  if (p.status === "awaiting_approval") card.append(approvalActions(p));
}

function approvalActions(p) {
  const box = el("div", { class: "actions" });
  const decline = el("button", { class: "secondary", onclick: () => declinePurchase(p.id) }, "Not this time");

  if (config.paypalMock) {
    box.append(
      el(
        "button",
        {
          class: "mock",
          onclick: async () => {
            const { orderId } = await api(`/api/purchases/${p.id}/order`, { method: "POST" });
            await finishApproval(p.id, orderId);
          },
        },
        `Approve ${money(p.amount)} with PayPal (simulated)`,
      ),
      decline,
    );
    return box;
  }

  const slot = el("div");
  box.append(slot, decline);
  loadPayPal()
    .then((paypal) =>
      paypal
        .Buttons({
          style: { label: "pay", layout: "vertical", height: 40 },
          createOrder: async () => (await api(`/api/purchases/${p.id}/order`, { method: "POST" })).orderId,
          onApprove: async (data) => finishApproval(p.id, data.orderID),
          onError: (err) => toast(`PayPal error: ${err?.message || err}`, true),
        })
        .render(slot),
    )
    .catch((err) => slot.append(el("p", { class: "hint" }, err.message)));
  return box;
}

async function finishApproval(id, orderId) {
  try {
    const r = await api(`/api/purchases/${id}/capture`, { method: "POST", body: { orderId } });
    state = r.state;
    renderSide();
    refreshPurchaseCards(r.purchase);
    addToChat(el("div", { class: "msg agent" }, `Thanks! ${r.purchase.title} is paid (${money(r.purchase.amount)}) through PayPal.`));
  } catch (err) {
    toast(err.message, true);
  }
}

async function declinePurchase(id) {
  const r = await api(`/api/purchases/${id}/decline`, { method: "POST" });
  state = r.state;
  renderSide();
  refreshPurchaseCards(r.purchase);
}

function refreshPurchaseCards(p) {
  document.querySelectorAll(`[data-purchase="${p.id}"]`).forEach((card) => fillPurchaseCard(card, p));
}

let busy = false;
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $("send").disabled = true;
  $("input").value = "";
  autosize();
  addToChat(el("div", { class: "msg user" }, text));
  const typing = addToChat(el("div", { class: "typing" }, "Errand is working on it"));
  try {
    const r = await api("/api/chat", { method: "POST", body: { message: text } });
    typing.remove();
    r.events.filter((e) => e.type === "products").forEach(renderProducts);
    addToChat(el("div", { class: "msg agent" }, r.text));
    r.events.filter((e) => e.type === "purchase").forEach((e) => addToChat(purchaseCard(e.purchase)));
    state = r.state;
    renderSide();
  } catch (err) {
    typing.remove();
    addToChat(el("div", { class: "msg error" }, `Something went wrong: ${err.message}`));
  } finally {
    busy = false;
    $("send").disabled = false;
    $("input").focus();
  }
}

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
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
$("input").addEventListener("input", autosize);

$("new-errand").addEventListener("click", async () => {
  await api("/api/chat/reset", { method: "POST" });
  $("messages").replaceChildren(
    el(
      "div",
      { class: "welcome", id: "welcome" },
      el("h2", {}, "What do you need picked up?"),
      el("p", {}, "Errand searches real stores, picks the best option and pays with your PayPal, but only inside the rules you set on the right."),
      el("div", { class: "suggestions", id: "suggestions" }),
    ),
  );
  renderSuggestions();
});

// --- Toasts ---------------------------------------------------------------------------

function toast(text, isError = false) {
  const t = el("div", { class: `msg ${isError ? "error" : "agent"}`, style: "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10;box-shadow:0 4px 20px rgba(0,0,0,.2)" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// --- Boot -------------------------------------------------------------------------------

(async function boot() {
  [config, state] = await Promise.all([api("/api/config"), api("/api/state")]);
  // The page shows a fresh chat on load, so start the agent fresh too.
  await api("/api/chat/reset", { method: "POST" });
  renderPills();
  renderSuggestions();
  renderSide();
})();
