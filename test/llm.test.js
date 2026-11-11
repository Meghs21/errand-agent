// The Groq adapter translates Anthropic-style requests and responses, so the
// agent loop, intent check and drafter run unchanged on either provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { groqClient } from "../src/llm.js";

function stub(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, path: req.url, body: parsed });
      const [status, out] = reply(parsed, seen.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("tool use round-trips through the OpenAI-compatible format", async () => {
  const { server, seen, url } = await stub(() => [200, {
    model: "m",
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "Searching.", tool_calls: [{ id: "call_1", type: "function", function: { name: "search_products", arguments: '{"query":"tackle box"}' } }] } }],
  }]);
  const client = groqClient({ apiKey: "k", baseUrl: url });
  const r = await client.beta.messages.create({
    model: "openai/gpt-oss-120b",
    max_tokens: 1000,
    system: "sys",
    tools: [{ name: "search_products", description: "d", input_schema: { type: "object", properties: {} } }],
    output_config: { effort: "medium" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "ok" }, { type: "tool_use", id: "call_0", name: "get_mandate", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_0", content: '{"remaining":100}' }] },
    ],
  });
  server.close();
  assert.equal(r.stop_reason, "tool_use");
  assert.deepEqual(r.content, [{ type: "text", text: "Searching." }, { type: "tool_use", id: "call_1", name: "search_products", input: { query: "tackle box" } }]);
  const sent = seen[0];
  assert.equal(sent.auth, "Bearer k");
  assert.equal(sent.path, "/chat/completions");
  assert.equal(sent.body.reasoning_effort, "medium");
  assert.equal(sent.body.tools[0].function.name, "search_products");
  assert.deepEqual(sent.body.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(sent.body.messages[2].tool_calls[0].function.arguments, "{}");
  assert.equal(sent.body.messages[3].tool_call_id, "call_0");
});

test("structured output uses strict json_schema and retries a failed generation once", async () => {
  const { server, seen, url } = await stub((_, n) =>
    n === 1
      ? [400, { error: { code: "json_validate_failed", message: "bad" } }]
      : [200, { choices: [{ finish_reason: "stop", message: { content: '{"decision":"approve"}' } }] }],
  );
  const client = groqClient({ apiKey: "k", baseUrl: url });
  const r = await client.messages.create({ model: "x", max_tokens: 100, messages: [{ role: "user", content: "c" }], output_config: { format: { type: "json_schema", schema: { type: "object" } } } });
  server.close();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body.response_format.type, "json_schema");
  assert.equal(seen[0].body.response_format.json_schema.strict, true);
  assert.equal(r.stop_reason, "end_turn");
  assert.equal(r.content[0].text, '{"decision":"approve"}');
});

test("other errors surface", async () => {
  const { server, url } = await stub(() => [401, { error: { message: "Invalid API Key" } }]);
  await assert.rejects(groqClient({ apiKey: "bad", baseUrl: url }).messages.create({ model: "x", messages: [] }), /Invalid API Key/);
  server.close();
});
