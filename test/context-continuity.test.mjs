import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function json(response, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function runRouter(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitForRouter(port, child) {
  const url = `${callerBaseUrl(port, CALLER_KEY)}/models`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Router exited: ${child.testErrors()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The router has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for router: ${child.testErrors()}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function sessionFiles(rootDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else files.push(path.relative(rootDirectory, target));
    }
  };
  visit(rootDirectory);
  return files.sort();
}

function message(role, type, text) {
  return { type: "message", role, content: [{ type, text }] };
}

test("Codex-local history survives external A to external B to native GPT", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-context-continuity-"));
  const codexHome = path.join(fixture, "codex-home");
  const sessions = path.join(codexHome, "sessions", "2026", "08", "28");
  const state = path.join(fixture, "router-state");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(state, { recursive: true });
  const sessionPath = path.join(sessions, "canonical-history.jsonl");
  const sessionBytes = [
    JSON.stringify({ role: "user", text: "CANONICAL_START" }),
    JSON.stringify({ role: "tool", text: "TOOL_RESULT_42" }),
    JSON.stringify({ role: "subagent", text: "SUBAGENT_HANDOFF_73" }),
  ].join("\n") + "\n";
  writeFileSync(sessionPath, sessionBytes, "utf8");
  const beforeMtime = statSync(sessionPath, { bigint: true }).mtimeNs;
  const beforeFiles = sessionFiles(path.join(codexHome, "sessions"));

  const gatewayRequests = [];
  const nativeRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, { id: `external-${gatewayRequests.length}`, object: "response", output: [] });
  });
  const native = await mockServer(async (request, response) => {
    nativeRequests.push(await bodyJson(request));
    json(response, { id: "native-final", object: "response", output: [] });
  });
  const routerPort = await openPort();
  const router = runRouter({
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
  });

  const tools = [
    {
      type: "function",
      name: "shell",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  ];
  const handoff = {
    type: "agent_message",
    content: [
      {
        type: "input_text",
        text: "Message Type: FINAL_ANSWER\nTask name: continuity-child\nSender: child\nPayload:\n",
      },
      { type: "encrypted_content", encrypted_content: "SUBAGENT_HANDOFF_73" },
    ],
  };
  const historyA = [
    message("user", "input_text", "CANONICAL_START"),
    { type: "function_call", call_id: "call_42", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_42", output: "TOOL_RESULT_42" },
    handoff,
  ];
  const historyB = [
    ...historyA,
    message("assistant", "output_text", "MODEL_A_DECISION_11"),
    message("user", "input_text", "CONTINUE_ON_MODEL_B"),
  ];
  const historyNative = [
    ...historyB,
    message("assistant", "output_text", "MODEL_B_DECISION_29"),
    message("user", "input_text", "RETURN_TO_NATIVE_GPT"),
  ];
  const headers = {
    Authorization: "Bearer original-codex-upstream-credential",
    "Content-Type": "application/json",
  };
  const send = (model, input, previousResponseId) =>
    fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input,
        tools,
        store: true,
        previous_response_id: previousResponseId,
      }),
    });

  try {
    await waitForRouter(routerPort, router);
    assert.equal(
      (await send("deepseek/deepseek-v4-flash", historyA, "provider-a-chain")).status,
      200,
    );
    assert.equal(
      (await send("anthropic-api/claude-opus-4.8", historyB, "provider-b-chain")).status,
      200,
    );
    assert.equal(
      (await send("gpt-5.6-sol", historyNative, "native-provider-chain")).status,
      200,
    );

    assert.equal(gatewayRequests.length, 2);
    assert.equal(gatewayRequests[0].model, "deepseek-v4-flash");
    assert.equal(gatewayRequests[1].model, "anthropic-api-claude-opus-4-8");
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].model, "gpt-5.6-sol");

    for (const request of [...gatewayRequests, ...nativeRequests]) {
      assert.equal(request.store, false);
      assert.equal(request.previous_response_id, undefined);
      assert.match(JSON.stringify(request.input), /CANONICAL_START/u);
      assert.match(JSON.stringify(request.input), /TOOL_RESULT_42/u);
      assert.match(JSON.stringify(request.input), /SUBAGENT_HANDOFF_73/u);
    }
    assert.match(JSON.stringify(gatewayRequests[1].input), /MODEL_A_DECISION_11/u);
    const nativeContext = JSON.stringify(nativeRequests[0].input);
    for (const marker of [
      "MODEL_A_DECISION_11",
      "CONTINUE_ON_MODEL_B",
      "MODEL_B_DECISION_29",
      "RETURN_TO_NATIVE_GPT",
    ]) {
      assert.match(nativeContext, new RegExp(marker, "u"));
    }
    assert.doesNotMatch(nativeContext, /encrypted_content/u);

    assert.equal(readFileSync(sessionPath, "utf8"), sessionBytes);
    assert.equal(statSync(sessionPath, { bigint: true }).mtimeNs, beforeMtime);
    assert.deepEqual(sessionFiles(path.join(codexHome, "sessions")), beforeFiles);
  } finally {
    await stop(router);
    await Promise.all([close(gateway.server), close(native.server)]);
    rmSync(fixture, { recursive: true, force: true });
  }
});
