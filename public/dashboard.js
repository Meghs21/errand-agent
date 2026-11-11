// AgentPass owner dashboard: link PayPal, issue and revoke mandates, approve
// held payments, and see every decision with its reasons.
import { $, el, api, money, toast, renderPills, STATUS_LABEL, ago } from "/ui.js";

let config = {};
let data = null;
let paypalReady = null;
let walletKey = null; // re-render the wallet (and its PayPal button) only when it changes

// --- Navigation -----------------------------------------------------------------------

const VIEWS = ["home", "activity", "agents", "wallet"];
const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home");

function showView() {
  const v = currentView();
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== v;
  document.querySelectorAll(".sidenav a").forEach((a) => (a.dataset.view === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (data) render();
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", showView);
const go = (view) => (location.hash = view);

// --- Wallet (PayPal JS SDK is used only to link it) -------------------------------------

function loadPayPal() {
  paypalReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId)}&currency=USD&components=buttons`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error("Could not load PayPal"));
    document.head.append(s);
  });
  return paypalReady;
}

async function renderWallet() {
  // The PayPal button needs a visible container, so only draw while the Wallet view is open.
  if (currentView() !== "wallet") return (walletKey = null);
  const key = JSON.stringify(data.wallet);
  if (key === walletKey) return;
  walletKey = key;
  const box = $("wallet");
  if (data.wallet) {
    box.replaceChildren(
      el(
        "div",
        { class: "wallet-linked" },
        el("div", { class: "wallet-mark" }, "✓"),
        el("div", { class: "grow" }, el("b", {}, "PayPal linked"), el("div", { class: "hint" }, data.wallet.email || "PayPal account")),
        el("button", { class: "danger", onclick: unlinkWallet }, "Unlink"),
      ),
      el("p", { class: "hint" }, "Agents never see this wallet. They only hold a mandate, and AgentPass checks every payment before PayPal moves any money."),
    );
    return;
  }
  const slot = el("div", { class: "paypal-slot" });
  box.replaceChildren(
    el("h3", {}, "Link your PayPal"),
    el("p", { class: "hint" }, "Do this once. Nothing is charged now. Agents you authorize can then pay within the limits you set."),
    slot,
  );
  if (config.paypalMock) {
    slot.append(el("button", { class: "mock", onclick: () => linkWallet("MOCK-SETUP") }, "Link PayPal (simulated)"));
    return;
  }
  try {
    const paypal = await loadPayPal();
    await paypal
      .Buttons({
        style: { label: "paypal", layout: "vertical", height: 44 },
        createVaultSetupToken: async () => (await api("/api/wallet/setup-token", { method: "POST" })).id,
        onApprove: async ({ vaultSetupToken }) => linkWallet(vaultSetupToken),
        onError: (err) => toast(`PayPal error: ${err?.message || err}`, true),
      })
      .render(slot);
  } catch (err) {
    slot.append(el("p", { class: "hint" }, err.message));
  }
}

async function linkWallet(vaultSetupToken) {
  try {
    data = await api("/api/wallet/link", { method: "POST", body: { vaultSetupToken } });
    toast("PayPal linked.");
    go(data.mandates.length ? "home" : "agents");
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function unlinkWallet() {
  if (!confirm("Unlink PayPal? Agents won't be able to pay until you link it again.")) return;
  data = await api("/api/wallet", { method: "DELETE" });
  walletKey = null;
  render();
}

// --- Home: first-run guide and totals ---------------------------------------------------

function renderOnboarding() {
  const hasWallet = Boolean(data.wallet);
  const hasMandate = data.mandates.length > 0;
  const hasPayment = data.payments.length > 0;
  if (hasWallet && hasMandate && hasPayment) return $("onboarding").replaceChildren();
  const step = (done, n, title, sub, action) =>
    el("li", { class: done ? "done" : "" }, el("span", { class: "dot" }, done ? "✓" : n), el("div", { class: "grow" }, el("b", {}, title), el("div", { class: "hint" }, sub)), done ? null : action);
  const errandLink = hasMandate ? el("a", { class: "nav-link", href: "/errand", target: "_blank" }, "Open Errand ↗") : null;
  $("onboarding").replaceChildren(
    el(
      "section",
      { class: "panel guide" },
      el("h3", {}, "Get started in three steps"),
      el(
        "ol",
        {},
        step(hasWallet, 1, "Link your PayPal", "Once. Nothing is charged.", el("button", { class: "primary", onclick: () => go("wallet") }, "Link PayPal")),
        step(hasMandate, 2, "Give an agent a mandate", "What it may buy, and how much.", el("button", { class: hasWallet ? "primary" : "secondary", onclick: openDialog }, "New mandate")),
        step(hasPayment, 3, "Let it shop", "Every payment it asks for shows up here.", errandLink),
      ),
    ),
  );
}

function renderStats() {
  const sum = (status) => data.payments.filter((p) => p.status === status).reduce((s, p) => s + p.amount, 0);
  const count = (pred) => data.payments.filter(pred).length;
  const held = count((p) => p.status === "held");
  const stat = (label, value, sub, cls = "") => el("div", { class: `stat ${cls}` }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), el("div", { class: "hint" }, sub));
  $("stats").replaceChildren(
    stat("Spent by agents", money(sum("captured")), `${count((p) => p.status === "captured")} paid`),
    stat("Waiting for you", money(sum("held")), held ? `${held} on hold` : "Nothing on hold", held ? "warn" : ""),
    stat("Blocked", String(count((p) => p.status === "rejected")), "requests stopped", count((p) => p.status === "rejected") ? "bad" : ""),
    stat("Active agents", String(data.mandates.filter((m) => m.status === "active").length), `${data.mandates.length} mandate${data.mandates.length === 1 ? "" : "s"} in total`),
  );
  $("stats").hidden = data.payments.length === 0; // nothing to total up on a first visit
  const badge = $("nav-held");
  badge.hidden = !held;
  badge.textContent = held;
}

// --- Agents (mandates) ------------------------------------------------------------------

function renderMandates() {
  const box = $("mandates");
  if (!data.mandates.length) {
    box.replaceChildren(
      el("div", { class: "panel empty-state" }, el("b", {}, "No agents yet"), el("p", { class: "hint" }, "A mandate lets one agent pay for one purpose, within limits you set."), el("button", { class: "primary", onclick: openDialog }, "+ New mandate")),
    );
    return;
  }
  box.replaceChildren(
    ...data.mandates.map((m) => {
      const pct = Math.min(100, (m.used / m.totalLimit) * 100);
      const active = m.status === "active";
      return el(
        "article",
        { class: `panel mandate ${m.status}` },
        el("div", { class: "row" }, el("b", { class: "agent-name" }, m.agentName), el("span", { class: `badge ${active ? "captured" : "rejected"}` }, m.status)),
        el("p", { class: "purpose" }, `“${m.purpose}”`),
        el("div", { class: "meter-bar" }, el("span", { style: `width:${pct}%`, class: pct >= 85 ? "hot" : "" })),
        el("div", { class: "row hint" }, el("span", {}, `${money(m.used)} spent`), el("span", {}, `${money(m.remaining)} left of ${money(m.totalLimit)}`)),
        el(
          "ul",
          { class: "facts" },
          el("li", {}, "Pays on its own up to ", el("b", {}, money(m.autoApproveLimit))),
          el("li", {}, "Never more than ", el("b", {}, money(m.perPurchaseLimit)), " at once"),
          el("li", {}, active ? `Ends ${new Date(m.expiresAt).toLocaleDateString()}` : "No longer works"),
        ),
        active ? el("div", { class: "btns" }, el("button", { class: "kill", onclick: () => revoke(m) }, "⏻ Revoke now")) : null,
      );
    }),
  );
}

async function revoke(m) {
  if (!confirm(`Revoke ${m.agentName}'s mandate? It stops working immediately and any held payments are released.`)) return;
  data = await api(`/api/mandates/${m.id}/revoke`, { method: "POST" });
  render();
  toast(`${m.agentName} can no longer pay.`);
}

// --- New mandate dialog ----------------------------------------------------------------

function openDialog() {
  $("sheet-form").hidden = false;
  $("issued").hidden = true;
  $("sheet-title").textContent = "Give an agent a mandate";
  $("agent-dialog").showModal();
  $("draft-text").focus();
}
$("new-agent").addEventListener("click", openDialog);
$("close-dialog").addEventListener("click", () => $("agent-dialog").close());
$("agent-dialog").addEventListener("click", (e) => e.target === e.currentTarget && e.currentTarget.close()); // click outside closes

$("draft-btn").addEventListener("click", async () => {
  const btn = $("draft-btn");
  const text = $("draft-text").value.trim();
  if (!text) return toast("Describe the permission first.", true);
  btn.disabled = true;
  btn.textContent = "Drafting…";
  try {
    const d = await api("/api/mandates/draft", { method: "POST", body: { text } });
    const f = $("mandate-form");
    f.agentName.value = d.agentName;
    f.purpose.value = d.purpose;
    f.perPurchaseLimit.value = d.perPurchaseLimit;
    f.autoApproveLimit.value = d.autoApproveLimit;
    f.totalLimit.value = d.totalLimit;
    f.expiresInDays.value = d.expiresInDays;
    f.maxPaymentsPerDay.value = d.maxPaymentsPerDay;
    f.allowedMerchants.value = d.allowedMerchants.join(", ");
    const blocked = new Set(f.blockedKeywords.value.split(",").map((k) => k.trim()).filter(Boolean));
    d.extraBlockedKeywords.forEach((k) => blocked.add(k.toLowerCase()));
    f.blockedKeywords.value = [...blocked].join(", ");
    f.classList.add("flash");
    setTimeout(() => f.classList.remove("flash"), 1200);
    toast("Drafted. Check the limits, then issue the mandate.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Draft with AI";
  }
});

$("preset").addEventListener("click", () => {
  const f = $("mandate-form");
  f.agentName.value = "Errand";
  f.purpose.value = "Birthday gifts for my dad. He loves fishing and coffee.";
  f.perPurchaseLimit.value = 80;
  f.autoApproveLimit.value = 40;
  f.totalLimit.value = 150;
  f.expiresInDays.value = 14;
  f.maxPaymentsPerDay.value = 5;
  f.allowedMerchants.value = "";
  f.classList.add("flash");
  setTimeout(() => f.classList.remove("flash"), 1200);
});

$("mandate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api("/api/mandates", {
      method: "POST",
      body: {
        agentName: f.agentName.value,
        purpose: f.purpose.value,
        perPurchaseLimit: f.perPurchaseLimit.value,
        autoApproveLimit: f.autoApproveLimit.value,
        totalLimit: f.totalLimit.value,
        expiresInDays: f.expiresInDays.value,
        maxPaymentsPerDay: f.maxPaymentsPerDay.value,
        allowedMerchants: f.allowedMerchants.value,
        blockedKeywords: f.blockedKeywords.value,
      },
    });
    showIssued(r);
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

function showIssued({ mandate, token, mcpConfig }) {
  $("sheet-form").hidden = true;
  $("sheet-title").textContent = `${mandate.agentName} can now pay`;
  const copy = (text, label) => el("button", { type: "button", class: "secondary", onclick: () => navigator.clipboard.writeText(text).then(() => toast(`${label} copied`)) }, `Copy ${label}`);
  const json = JSON.stringify(mcpConfig, null, 2);
  const box = $("issued");
  box.hidden = false;
  box.replaceChildren(
    el(
      "div",
      { class: "issued" },
      el("p", {}, "Give this key to the agent. It's shown only once."),
      el("code", { class: "token" }, token),
      el(
        "div",
        { class: "btns" },
        el("a", { class: "button primary", href: `/errand#token=${encodeURIComponent(token)}`, target: "_blank", onclick: () => $("agent-dialog").close() }, "Use it in Errand ↗"),
        copy(token, "key"),
      ),
      el("details", { class: "tech" }, el("summary", {}, "For developers: connect Claude Desktop or any MCP client"), el("pre", {}, json), copy(json, "MCP config")),
    ),
  );
}

// --- Payments ---------------------------------------------------------------------------

const riskClass = (r) => (r >= 60 ? "high" : r >= 30 ? "mid" : "low");
const itemsText = (p) => p.items.map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name)).join(", ");
const ICON = { captured: "✓", held: "⏸", rejected: "✕", declined: "↺", refunded: "↺", failed: "!", processing: "…" };

// The three gates every payment passes through, as a row of lit-up chips.
function gates(p) {
  const limitsOk = p.checks.length > 0 && p.checks.every((c) => c.pass);
  const failedLimit = p.checks.find((c) => !c.pass);
  const v = p.verdict;
  const ai = !v
    ? ["skip", limitsOk ? "AI check…" : "AI check skipped"]
    : v.decision === "approve"
      ? ["ok", "AI: fits purpose"]
      : v.decision === "reject"
        ? ["bad", "AI: rejected"]
        : ["warn", "AI: needs review"];
  const pp = {
    captured: ["ok", p.approvedBy === "owner" ? "PayPal: paid after your OK" : "PayPal: paid"],
    held: ["warn", "PayPal: on hold"],
    declined: ["skip", "PayPal: hold released"],
    refunded: ["skip", "PayPal: refunded"],
    rejected: ["skip", "PayPal: not charged"],
    failed: ["bad", "PayPal: error"],
    processing: ["skip", "PayPal…"],
  }[p.status] || ["skip", "PayPal"];
  const chip = ([cls, text]) => el("span", { class: `gate ${cls}` }, text);
  return el(
    "div",
    { class: "gates" },
    chip(limitsOk ? ["ok", "Limits passed"] : ["bad", failedLimit ? `Limit: ${failedLimit.name.replace(/_/g, " ")}` : "Limits"]),
    el("span", { class: "arrow" }, "→"),
    chip(ai),
    el("span", { class: "arrow" }, "→"),
    chip(pp),
  );
}

// Everything behind "Why": the checks, the AI's reasoning, and the raw ids for the curious.
function explanation(p) {
  const ids = [
    `payment ${p.id}`,
    p.paypal.orderId && `PayPal order ${p.paypal.orderId}`,
    p.paypal.authorizationId && `authorization ${p.paypal.authorizationId}`,
    p.paypal.captureId && `capture ${p.paypal.captureId}`,
    p.paypal.refundId && `refund ${p.paypal.refundId}`,
  ].filter(Boolean);
  return [
    p.verdict
      ? el(
          "div",
          { class: "verdict" },
          el("div", {}, "AI check: ", el("b", {}, p.verdict.decision.replace("_", " ")), " ", el("span", { class: `risk ${riskClass(p.verdict.risk_score)}` }, `risk ${p.verdict.risk_score}/100`)),
          el("ul", { class: "reasons" }, p.verdict.reasons.map((r) => el("li", {}, r))),
        )
      : null,
    p.description ? el("div", { class: "verdict" }, el("b", {}, "The agent said: "), p.description) : null,
    el("ul", { class: "checks" }, p.checks.map((c) => el("li", { class: c.pass ? "" : "fail" }, c.detail))),
    p.error ? el("div", { class: "verdict" }, p.error) : null,
    el("details", { class: "tech" }, el("summary", {}, "Technical details"), el("div", { class: "ids" }, ids.join(" · "))),
  ];
}

const isNew = (p) => (seen.has(p.id) ? "" : " new");

// A card for the approval queue: everything needed to decide, right there.
function approvalCard(p) {
  return el(
    "div",
    { class: `pay held${isNew(p)}` },
    el("div", { class: "row" }, el("span", { class: "items" }, itemsText(p)), el("span", { class: "amount" }, money(p.amount))),
    el("div", { class: "who" }, `${p.agentName} → ${p.merchant} · ${ago(p.createdAt)}`),
    gates(p),
    el("ul", { class: "reasons" }, p.reasons.map((r) => el("li", {}, r))),
    el("div", { class: "btns" }, el("button", { class: "primary", onclick: () => act(p, "approve") }, `Approve ${money(p.amount)}`), el("button", { class: "secondary", onclick: () => act(p, "decline") }, "Decline")),
    el("details", { class: "why" }, el("summary", {}, "Why is this on hold?"), ...explanation(p)),
  );
}

// One line per payment; click it to see why.
const expanded = new Set(); // rows the owner expanded, kept open across live refreshes
function paymentRow(p) {
  const d = el(
    "details",
    { class: `tx ${p.status}${isNew(p)}`, ontoggle: (e) => (e.currentTarget.open ? expanded.add(p.id) : expanded.delete(p.id)) },
    el(
      "summary",
      {},
      el("span", { class: `tx-icon ${p.status}`, "aria-hidden": "true" }, ICON[p.status] || "•"),
      el("span", { class: "tx-main" }, el("span", { class: "tx-title" }, itemsText(p)), el("span", { class: "tx-sub" }, `${p.agentName} → ${p.merchant} · ${ago(p.createdAt)}`)),
      el("span", { class: "tx-right" }, el("span", { class: "amount" }, money(p.amount)), el("span", { class: `badge ${p.status}` }, STATUS_LABEL[p.status] || p.status)),
    ),
    el(
      "div",
      { class: "tx-body" },
      gates(p),
      p.status !== "captured" && p.reasons.length ? el("ul", { class: "reasons" }, p.reasons.map((r) => el("li", {}, r))) : null,
      ...explanation(p),
      p.status === "captured" ? el("div", { class: "btns" }, el("button", { class: "danger", onclick: () => act(p, "refund") }, "Refund")) : null,
    ),
  );
  if (expanded.has(p.id)) d.open = true;
  return d;
}

async function act(p, action) {
  if (action === "refund" && !confirm(`Refund ${money(p.amount)} to your PayPal?`)) return;
  try {
    data = await api(`/api/payments/${p.id}/${action}`, { method: "POST" });
    render();
    toast({ approve: "Approved. PayPal took the payment.", decline: "Declined. The hold is released.", refund: "Refunded." }[action]);
  } catch (err) {
    toast(err.message, true);
    refresh();
  }
}

const FILTERS = [
  ["all", "All", () => true],
  ["captured", "Paid", (p) => p.status === "captured"],
  ["held", "On hold", (p) => p.status === "held"],
  ["blocked", "Blocked", (p) => p.status === "rejected" || p.status === "failed"],
  ["other", "Refunded or declined", (p) => p.status === "refunded" || p.status === "declined"],
];
let filter = "all";

function renderFilters() {
  $("filters").replaceChildren(
    ...FILTERS.map(([key, label, pred]) => {
      const n = data.payments.filter(pred).length;
      return el("button", { type: "button", class: `chip${filter === key ? " on" : ""}`, "aria-pressed": String(filter === key), onclick: () => ((filter = key), (lastPaymentsKey = null), render()) }, `${label} ${n}`);
    }),
  );
}

const emptyList = (text) => el("p", { class: "empty" }, text);

let lastPaymentsKey = null;
const seen = new Set(); // payment ids already shown, so only new ones animate in
function renderPayments() {
  // Don't rebuild while nothing changed, so expanded rows stay put.
  const key = JSON.stringify([currentView(), filter, data.payments.map((p) => [p.id, p.status])]);
  if (key === lastPaymentsKey) return;
  lastPaymentsKey = key;

  const held = data.payments.filter((p) => p.status === "held");
  $("approvals-card").hidden = held.length === 0;
  $("approvals").replaceChildren(...held.map(approvalCard));

  const recent = data.payments.filter((p) => p.status !== "held").slice(0, 5);
  $("recent").replaceChildren(...(recent.length ? recent.map(paymentRow) : [emptyList("When an agent asks to pay, it shows up here.")]));

  renderFilters();
  const pred = FILTERS.find(([k]) => k === filter)[2];
  const list = data.payments.filter(pred);
  $("payments").replaceChildren(...(list.length ? list.map(paymentRow) : [emptyList(filter === "all" ? "No payments yet." : "Nothing here.")]));

  // Mark everything rendered as seen after this paint, so the next refresh doesn't re-animate it.
  requestAnimationFrame(() => data.payments.forEach((p) => seen.add(p.id)));
}

// --- Wiring -----------------------------------------------------------------------------

function render() {
  renderOnboarding();
  renderStats();
  renderMandates();
  renderPayments();
  renderWallet();
}

async function refresh() {
  try {
    data = await api("/api/overview");
    render();
  } catch {
    /* server restarting; try again next tick */
  }
}

$("reset-demo").addEventListener("click", async () => {
  if (!confirm("Clear all mandates and payments? Your linked PayPal stays linked.")) return;
  data = await api("/api/reset", { method: "POST" });
  lastPaymentsKey = null;
  go("home");
  render();
});

(async function boot() {
  config = await api("/api/config");
  renderPills(config, $("pills"));
  showView();
  await refresh();
  // Agents pay from elsewhere (Errand, Claude Desktop), so keep the view live.
  setInterval(refresh, 2500);
})();
