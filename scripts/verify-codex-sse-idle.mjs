// Explicit opt-in integration check: runs the installed Codex CLI against a
// loopback-only mock, never a provider, using an ephemeral isolated home.
// Usage: node scripts/verify-codex-sse-idle.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCodexBinary } from "../src/codex-binary.mjs";
import { pipeResponse } from "../src/http-utils.mjs";

const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const message = { id: "msg_idle_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "IDLE_TEST_OK", annotations: [] }] };
const completed = { id: "resp_idle_test", object: "response", model: "gpt-5.5", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
const resultStream = event("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } })
  + event("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: "IDLE_TEST_OK" })
  + event("response.output_item.done", { output_index: 0, item: message })
  + event("response.completed", { response: completed });

async function run(mode) {
  let posts = 0;
  const server = http.createServer(async (request, response) => {
    request.resume();
    if (request.method !== "POST") { response.writeHead(404).end(); return; }
    posts++;
    if (mode === "comments") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(event("response.created", { response: { ...completed, status: "in_progress", output: [] } }));
      const timer = setInterval(() => response.write(": still-working\n\n"), 200);
      const done = setTimeout(() => response.end(resultStream), 6000);
      response.once("close", () => { clearInterval(timer); clearTimeout(done); });
    } else {
      let timer;
      const upstream = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(event("response.created", { response: { ...completed, status: "in_progress", output: [] } })));
          timer = setTimeout(() => { controller.enqueue(Buffer.from(resultStream)); controller.close(); }, 6000);
        },
        cancel() { clearTimeout(timer); },
      }), { headers: { "content-type": "text/event-stream" } });
      await pipeResponse(upstream, response, new Set(), [], { sseHeartbeatMs: 200 });
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-idle-proof-"));
  let child;
  try {
    writeFileSync(path.join(root, "instructions.md"), "Reply with IDLE_TEST_OK. Do not use tools.");
    writeFileSync(path.join(root, "config.toml"), [
      'model = "gpt-5.5"', 'model_provider = "idle-proof"',
      `model_instructions_file = ${JSON.stringify(path.join(root, "instructions.md"))}`,
      'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
      '[features]', 'plugins = false', 'remote_plugin = false', 'apps = false',
      '[model_providers.idle-proof]', 'name = "Idle proof"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'stream_idle_timeout_ms = 2000',
      'stream_max_retries = 0', 'request_max_retries = 0',
    ].join("\n"));
    child = spawn(findCodexBinary(), ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "--ignore-rules", "-C", root, "-"], {
      cwd: root, env: { ...process.env, CODEX_HOME: root }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", diagnostic = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-8000); });
    child.stdin.end("Output IDLE_TEST_OK.");
    const timeout = setTimeout(() => child.kill(), 60000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    const events = output.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const summary = { mode, code, posts, completed: events.some(e => e.type === "turn.completed"), idleTimeout: /idle timeout waiting for SSE/.test(output + diagnostic), final: events.filter(e => e.type === "item.completed" && e.item?.type === "agent_message").map(e => e.item.text).join("\n") };
    console.log(JSON.stringify(summary));
    if (mode === "comments") assert.equal(summary.idleTimeout, true);
    else { assert.equal(code, 0); assert.equal(summary.completed, true); assert.equal(summary.posts, 1); assert.equal(summary.final, "IDLE_TEST_OK"); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(path.join(os.tmpdir(), "codex-idle-proof-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
}
await run("comments");
await run("data-heartbeats");
