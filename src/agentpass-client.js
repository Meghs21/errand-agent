// Minimal client for the AgentPass agent API. This is all an agent needs:
// a base URL and the mandate token the owner gave it. Used by the Errand demo
// agent and the MCP server; any other agent can do the same with plain HTTP.

export function agentPassClient({ baseUrl, token }) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !json.payment_id) throw Object.assign(new Error(json.error || `AgentPass ${res.status}`), { status: res.status });
    return json;
  };
  return {
    /** Limits, what's left, expiry and purpose of this agent's mandate. */
    getMandate: () => call("GET", "/v1/mandate"),
    /** Ask to pay for a cart. The idempotency key makes retries safe. */
    pay: (cart, idempotencyKey) => call("POST", "/v1/payments", cart, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    getPayment: (id) => call("GET", `/v1/payments/${encodeURIComponent(id)}`),
  };
}
