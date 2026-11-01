#!/usr/bin/env node
// AgentPass MCP server: lets any MCP-capable agent (Claude Desktop, Claude
// Code, Cursor, your own) pay through an AgentPass mandate. It holds only the
// mandate token; PayPal credentials stay on the AgentPass server.
//
//   AGENTPASS_URL=http://localhost:3000 AGENTPASS_TOKEN=apm_... node mcp/server.js
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentPassClient } from "../src/agentpass-client.js";

const baseUrl = process.env.AGENTPASS_URL || "http://localhost:3000";
const token = process.env.AGENTPASS_TOKEN;
if (!token) {
  console.error("Set AGENTPASS_TOKEN to the mandate token from the AgentPass dashboard.");
  process.exit(1);
}
const agentpass = agentPassClient({ baseUrl, token });

const server = new McpServer({ name: "agentpass", version: "1.0.0" });

const asText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const asError = (err) => ({ content: [{ type: "text", text: `AgentPass error: ${err.message}` }], isError: true });

server.registerTool(
  "agentpass_get_mandate",
  {
    title: "Check spending mandate",
    description:
      "Get the spending mandate the user granted you: what it's for, per-purchase limit, auto-approve limit, total budget left, and expiry. Check this before shopping.",
    inputSchema: {},
  },
  async () => {
    try {
      return asText(await agentpass.getMandate());
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "agentpass_pay",
  {
    title: "Pay with PayPal via AgentPass",
    description:
      "Pay a merchant from the user's PayPal wallet under your mandate. AgentPass checks limits and whether the purchase fits the mandate's purpose. Result status: 'captured' (paid), 'held' (funds reserved; the user must approve in their dashboard), 'rejected' (not allowed, see reasons), or 'failed'. Never retry a rejected payment by splitting or relabeling it.",
    inputSchema: {
      merchant: z.string().describe("Merchant domain, e.g. rei.com"),
      items: z
        .array(
          z.object({
            name: z.string(),
            unit_price: z.number().positive().describe("Price per unit in USD"),
            quantity: z.number().int().min(1).default(1),
            category: z.string().optional(),
            url: z.string().optional(),
          }),
        )
        .min(1),
      description: z.string().describe("One or two sentences on why you're buying this, for the user and the intent check."),
      idempotency_key: z.string().optional().describe("Reuse the same key when retrying the same purchase so it can't be charged twice."),
    },
  },
  async ({ merchant, items, description, idempotency_key }) => {
    try {
      return asText(await agentpass.pay({ merchant, items, description }, idempotency_key || crypto.randomUUID()));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "agentpass_payment_status",
  {
    title: "Check a payment",
    description: "Get the current status of a payment, for example whether a held payment was approved or declined by the user.",
    inputSchema: { payment_id: z.string() },
  },
  async ({ payment_id }) => {
    try {
      return asText(await agentpass.getPayment(payment_id));
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
