// Which model provider AgentPass uses for its AI parts (the intent check, mandate
// drafting and the Errand demo agent). Claude via the Anthropic SDK by default;
// Groq (OpenAI-compatible API) as an alternative. The Groq client below speaks the
// same messages.create shape the rest of the code uses, so callers don't care which.
import Anthropic from "@anthropic-ai/sdk";

export const provider = () =>
  (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY && !process.env.ANTHROPIC_API_KEY ? "groq" : "anthropic")).toLowerCase();

export const isGroq = () => provider() === "groq";

export const aiName = () => (isGroq() ? "Groq" : "Claude");

export const aiReady = () =>
  isGroq() ? Boolean(process.env.GROQ_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Model for a given job. Groq uses one model for everything unless GROQ_MODEL is set.
export const modelFor = (anthropicModel) => (isGroq() ? process.env.GROQ_MODEL || "openai/gpt-oss-120b" : anthropicModel);

export const makeClient = () =>
  isGroq() ? groqClient({ apiKey: process.env.GROQ_API_KEY, baseUrl: process.env.GROQ_BASE_URL }) : new Anthropic();

// --- Groq adapter: Anthropic-style request in, Anthropic-style response out -------------

export function groqClient({ apiKey, baseUrl = "https://api.groq.com/openai/v1" } = {}) {
  baseUrl ||= "https://api.groq.com/openai/v1";
  async function create(req) {
    const body = {
      model: req.model,
      messages: toOpenAI(req.system, req.messages),
      max_completion_tokens: req.max_tokens || 4000,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    const fmt = req.output_config?.format;
    if (fmt?.type === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: fmt.schema } };
    }
    const effort = req.output_config?.effort;
    if (effort && /gpt-oss/.test(req.model)) body.reasoning_effort = effort === "low" ? "low" : effort === "medium" ? "medium" : "high";

    // Groq occasionally returns 400 for a malformed tool call or JSON; one retry usually fixes it.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return fromOpenAI(data);
      const code = data.error?.code;
      if (attempt === 0 && res.status === 400 && /tool_use_failed|json_validate_failed/.test(code || "")) continue;
      // Free-tier rate limit (tokens per minute): wait as long as Groq asks, then retry.
      if (res.status === 429 && attempt < 3) {
        const hinted = Number(res.headers.get("retry-after")) || Number(/try again in ([\d.]+)s/i.exec(data.error?.message || "")?.[1]);
        await new Promise((r) => setTimeout(r, Math.min(20, (hinted || 5) + 0.5) * 1000));
        continue;
      }
      throw Object.assign(new Error(`Groq: ${data.error?.message || `HTTP ${res.status}`}`), { status: res.status });
    }
  }
  return { messages: { create }, beta: { messages: { create } } };
}

function toOpenAI(system, messages) {
  const out = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text });
        }
      }
    }
  }
  return out;
}

function fromOpenAI(data) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(c.function?.arguments || "{}");
    } catch {}
    content.push({ type: "tool_use", id: c.id, name: c.function?.name, input });
  }
  const stop_reason = msg.tool_calls?.length ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
  return { content, stop_reason, model: data.model };
}
