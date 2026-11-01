// AgentPass owner dashboard: link PayPal, issue and revoke mandates, approve
// held payments, and see every decision with its reasons.
import { $, el, api, money, toast, renderPills, STATUS_LABEL, ago } from "/ui.js";

let config = {};
let data = null;
let paypalReady = null;
let walletKey = null; // re-render the wallet (and its PayPal button) only when it changes

// --- PayPal JS SDK (used only to link the wallet) -------------------------------

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
  const key = JSON.stringify(data.wallet);
  if (key === walletKey) return;
  walletKey = key;
  const box = $("wallet");
  if (data.wallet) {
    box.replaceChildren(
      el(
        "div",
        { class: "wallet-linked" },
        el("div", {}, el("div", { class: "ok" }, "Linked"), el("div", { class: "hint" }, data.wallet.email || "PayPal account")),
        el("button", { class: "danger", onclick: unlinkWallet }, "Unlink"),
      ),
      el("p", { class: "hint" }, "Agents never see this wallet. They only hold a mandate token, and every payment is checked here first."),
    );
    return;
  }
  const slot = el("div");
  box.replaceChildren(el("p", { class: "hint" }, "Link PayPal once. Agents you authorize can then pay within their mandates. Nothing is charged now."), slot);
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
    render();
    toast("PayPal linked.");
  } catch (err) {
    toast(err.message, true);
  }
}

async function unlinkWallet() {
  if (!confirm("Unlink PayPal? Agents won't be able to pay until you link it again.")) return;
  data = await api("/api/wallet", { method: "DELETE" });
  render();
}

// --- Mandates -----------------------------------------------------------------------

function renderMandates() {
  const box = $("mandates");
  if (!data.mandates.length) {
    box.replaceChildren(el("p", { class: "empty" }, "No agents yet. Grant a mandate below to give one a spending permission."));
    return;
  }
  box.replaceChildren(
    ...data.mandates.map((m) => {
      const pct = Math.min(100, (m.used / m.totalLimit) * 100);
      return el(
        "div",
        { class: `mandate ${m.status}` },
        el("div", { class: "row card-head" }, el("b", {}, m.agentName), el("span", { class: `badge ${m.status === "active" ? "captured" : "rejected"}` }, m.status)),
        el("div", { class: "purpose" }, `“${m.purpose}”`),
        el("div", { class: "meter-bar" }, el("span", { style: `width:${pct}%`, class: pct >= 85 ? "hot" : "" })),
        el("div", { class: "limits" }, `${money(m.used)} of ${money(m.totalLimit)} used · ${money(m.perPurchaseLimit)} per purchase · auto-approve up to ${money(m.autoApproveLimit)}`),
        el("div", { class: "limits" }, `${m.maxPaymentsPerDay}/day · expires ${new Date(m.expiresAt).toLocaleDateString()} · token ${m.tokenHint}`),
        m.status === "active" ? el("div", { class: "btns" }, el("button", { class: "danger", onclick: () => revoke(m) }, "Revoke now")) : null,
      );
    }),
  );
}

async function revoke(m) {
  if (!confirm(`Revoke ${m.agentName}'s mandate? Its token stops working immediately and any held payments are released.`)) return;
  data = await api(`/api/mandates/${m.id}/revoke`, { method: "POST" });
  render();
  toast(`${m.agentName} can no longer pay.`);
}

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
  const box = $("issued");
  box.hidden = false;
  const copy = (text, label) => el("button", { type: "button", class: "secondary", onclick: () => navigator.clipboard.writeText(text).then(() => toast(`${label} copied`)) }, `Copy ${label}`);
  const json = JSON.stringify(mcpConfig, null, 2);
  box.replaceChildren(
    el(
      "div",
      { class: "issued" },
      el("b", {}, `Mandate issued to ${mandate.agentName}`),
      el("div", {}, "Give this token to the agent. It's shown once; AgentPass only keeps a hash."),
      el("code", { class: "token" }, token),
      el("div", { class: "btns" }, copy(token, "token"), el("a", { class: "nav-link", href: `/errand#token=${encodeURIComponent(token)}`, target: "_blank" }, "Use it in Errand ↗")),
      el("div", {}, "Or plug it into Claude Desktop or any MCP client:"),
      el("pre", {}, json),
      el("div", { class: "btns" }, copy(json, "MCP config")),
    ),
  );
}

// --- Payments -------------------------------------------------------------------------

const riskClass = (r) => (r >= 60 ? "high" : r >= 30 ? "mid" : "low");

function paymentCard(p, { actions }) {
  const items = p.items.map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name)).join(", ");
  const details = el(
    "details",
    {},
    el("summary", {}, "Why"),
    el("ul", { class: "checks" }, p.checks.map((c) => el("li", { class: c.pass ? "" : "fail" }, c.detail))),
    p.verdict
      ? el(
          "div",
          { class: "verdict" },
          el("div", {}, "AI intent check: ", el("b", { class: "decision" }, p.verdict.decision.replace("_", " ")), " ", el("span", { class: `risk ${riskClass(p.verdict.risk_score)}` }, `risk ${p.verdict.risk_score}`)),
          el("ul", { class: "reasons" }, p.verdict.reasons.map((r) => el("li", {}, r))),
        )
      : null,
    p.description ? el("div", { class: "verdict" }, el("b", {}, "Agent said: "), p.description) : null,
    el(
      "div",
      { class: "ids" },
      [
        `payment ${p.id}`,
        p.paypal.orderId && `PayPal order ${p.paypal.orderId}`,
        p.paypal.authorizationId && `authorization ${p.paypal.authorizationId}`,
        p.paypal.captureId && `capture ${p.paypal.captureId}`,
        p.paypal.refundId && `refund ${p.paypal.refundId}`,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    p.error ? el("div", { class: "verdict" }, p.error) : null,
  );
  if (actions) details.open = true;

  const btns = el("div", { class: "btns" });
  if (p.status === "held" && actions) {
    btns.append(
      el("button", { class: "primary", onclick: () => act(p, "approve") }, `Approve ${money(p.amount)}`),
      el("button", { class: "secondary", onclick: () => act(p, "decline") }, "Decline"),
    );
  }
  if (p.status === "captured") btns.append(el("button", { class: "danger", onclick: () => act(p, "refund") }, "Refund"));

  return el(
    "div",
    { class: `pay ${p.status}` },
    el("div", { class: "row" }, el("span", { class: "who" }, `${p.agentName} → ${p.merchant} · ${ago(p.createdAt)}`), el("span", { class: `badge ${p.status}` }, STATUS_LABEL[p.status] || p.status)),
    el("div", { class: "row" }, el("span", { class: "items" }, items), el("span", { class: "amount" }, money(p.amount))),
    p.status !== "captured" && p.reasons.length ? el("ul", { class: "reasons" }, p.reasons.map((r) => el("li", {}, r))) : null,
    details,
    btns.childElementCount ? btns : null,
  );
}

async function act(p, action) {
  if (action === "refund" && !confirm(`Refund ${money(p.amount)} to your PayPal?`)) return;
  try {
    data = await api(`/api/payments/${p.id}/${action}`, { method: "POST" });
    render();
    toast({ approve: "Approved. PayPal captured the hold.", decline: "Declined. The hold is released.", refund: "Refunded." }[action]);
  } catch (err) {
    toast(err.message, true);
    refresh();
  }
}

let lastPaymentsKey = null;
function renderPayments() {
  // Don't rebuild while nothing changed, so open "Why" sections stay open.
  const key = JSON.stringify(data.payments.map((p) => [p.id, p.status]));
  if (key === lastPaymentsKey) return;
  lastPaymentsKey = key;

  const held = data.payments.filter((p) => p.status === "held");
  $("approvals-card").hidden = held.length === 0;
  $("approvals").replaceChildren(...held.map((p) => paymentCard(p, { actions: true })));

  const rest = data.payments.filter((p) => p.status !== "held");
  $("activity-count").textContent = data.payments.length ? `${data.payments.length} request${data.payments.length === 1 ? "" : "s"}` : "";
  $("payments").replaceChildren(
    ...(rest.length
      ? rest.map((p) => paymentCard(p, { actions: false }))
      : [el("p", { class: "empty" }, "When an agent asks to pay, every request shows up here with the checks it passed or failed.")]),
  );
}

function render() {
  renderWallet();
  renderMandates();
  renderPayments();
}

async function refresh() {
  try {
    data = await api("/api/overview");
    render();
  } catch {
    /* server restarting; try again next tick */
  }
}

(async function boot() {
  config = await api("/api/config");
  renderPills(config, $("pills"));
  await refresh();
  // Agents pay from elsewhere (Errand, Claude Desktop), so keep the view live.
  setInterval(refresh, 2500);
})();
