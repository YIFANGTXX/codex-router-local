import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environment(testRoot, extra = {}) {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(testRoot, "state", "generic-providers.json"),
    MODEL_ROUTER_USER_MODELS: path.join(testRoot, "state", "user-models.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "linux",
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "LaunchAgents"),
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    ...extra,
  };
}

function run(args, env, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    ...options,
  });
}

test("the connection shell stores only user-created routes and keeps the key out of metadata", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "router-connections-"));
  const secret = "TEST_CONNECTION_KEY_DO_NOT_PRINT";
  try {
    const env = environment(testRoot);
    const added = run([
      "src/connections.mjs", "add", "my-gateway",
      "--name", "My Gateway",
      "--base-url", "https://gateway.example.invalid/v1",
      "--adapter", "openai-responses",
      "--model", "coder-a",
      "--with-key",
    ], env, { input: secret });
    assert.equal(added.status, 0, added.stderr);
    assert.doesNotMatch(added.stdout, new RegExp(secret));
    const snapshot = JSON.parse(added.stdout);
    assert.equal(snapshot.security.canonicalHistory, "codex-local");
    assert.equal(snapshot.security.externalDefaults, 0);
    assert.deepEqual(snapshot.connections.map((connection) => connection.id), ["my-gateway"]);
    assert.deepEqual(snapshot.connections[0].models.map((model) => model.slug), ["my-gateway/coder-a"]);
    assert.equal(snapshot.connections[0].credential.configured, true);

    const state = path.join(testRoot, "state");
    const providerDocument = readFileSync(path.join(state, "generic-providers.json"), "utf8");
    const credentialDocument = readFileSync(path.join(state, "provider-credentials.json"), "utf8");
    assert.doesNotMatch(providerDocument, new RegExp(secret));
    assert.doesNotMatch(credentialDocument, new RegExp(secret));
    assert.equal(
      readFileSync(path.join(state, "generic-provider-credentials", "my-gateway.key"), "utf8").trim(),
      secret,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(state, "enabled-providers.json"), "utf8")).providers,
      ["my-gateway"],
      "adding one connection must not silently enable checked-in providers",
    );

    const registry = run([
      "--input-type=module",
      "--eval",
      "import('./src/model-registry.mjs').then(({PROVIDERS,MODEL_BY_SLUG}) => " +
        "console.log(JSON.stringify({generic:PROVIDERS.get('my-gateway')?.generic, model:MODEL_BY_SLUG.get('my-gateway/coder-a')?.upstreamModel})))",
    ], env);
    assert.equal(registry.status, 0, registry.stderr);
    assert.deepEqual(JSON.parse(registry.stdout), { generic: true, model: "coder-a" });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a connection may be saved before the user explicitly reads its provider model list", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "router-empty-connection-"));
  try {
    const env = environment(testRoot);
    const added = run([
      "src/connections.mjs", "add", "empty-gateway",
      "--name", "Empty Gateway",
      "--base-url", "https://gateway.example.invalid/v1",
      "--adapter", "openai-responses",
    ], env);
    assert.equal(added.status, 0, added.stderr);
    const snapshot = JSON.parse(added.stdout);
    assert.deepEqual(snapshot.connections[0].models, []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a local vision model keeps its modalities and reasoning ladder in the Codex catalog", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "router-local-profile-"));
  try {
    const env = environment(testRoot);
    const script = `
      import('./src/connections.mjs').then(async ({ addConnection }) => {
        await addConnection({
          id: 'local-gguf-qwen38',
          name: 'Local Qwen3.8',
          baseUrl: 'http://127.0.0.1:4268/v1',
          adapter: 'openai-chat',
          allowPrivate: true,
          apiKey: 'LOCAL_TEST_KEY',
          models: ['qwen3.8-27b-zerorefusal-vl-local'],
          contextWindow: 8192,
          modelProfile: {
            displayName: 'Qwen3.8 27B ZeroRefusal VL · 本地独立版',
            requestProfile: 'qwen38-community',
            metadata: {
              description: 'Local vision model',
              inputModalities: ['text', 'image'],
              reasoningLevels: [
                { effort: 'low', description: 'low reasoning' },
                { effort: 'medium', description: 'medium reasoning' },
                { effort: 'xhigh', description: 'xhigh reasoning' },
              ],
              defaultEffort: 'xhigh',
            },
          },
        });
      });
    `;
    const added = run(["--input-type=module", "--eval", script], env);
    assert.equal(added.status, 0, added.stderr);
    const document = JSON.parse(readFileSync(path.join(testRoot, "state", "user-models.json"), "utf8"));
    assert.equal(document.models.length, 1);
    const [model] = document.models;
    assert.equal(model.displayName, "Qwen3.8 27B ZeroRefusal VL · 本地独立版");
    assert.equal(model.requestProfile, "qwen38-community");
    assert.deepEqual(model.inputModalities, ["text", "image"]);
    assert.deepEqual(model.reasoningLevels.map((entry) => entry.effort), ["low", "medium", "xhigh"]);
    assert.equal(model.defaultEffort, "xhigh");
    assert.equal(model.contextWindow, 8192);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("editing a connection changes only its user-owned route metadata", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "router-edit-connection-"));
  const secret = "EDIT_CONNECTION_KEY";
  try {
    const env = environment(testRoot);
    const added = run([
      "src/connections.mjs", "add", "editable-gateway",
      "--name", "Editable Gateway",
      "--base-url", "https://gateway.example.invalid",
      "--adapter", "openai-responses",
      "--model", "model-a",
      "--with-key",
    ], env, { input: secret });
    assert.equal(added.status, 0, added.stderr);

    const edited = run([
      "src/connections.mjs", "edit", "editable-gateway",
      "--name", "Editable Gateway",
      "--base-url", "https://gateway.example.invalid/v1",
      "--adapter", "openai-responses",
    ], env);
    assert.equal(edited.status, 0, edited.stderr);
    const snapshot = JSON.parse(edited.stdout);
    assert.equal(snapshot.connections[0].baseUrl, "https://gateway.example.invalid/v1");
    assert.deepEqual(snapshot.connections[0].models.map((model) => model.id), ["model-a"]);
    assert.equal(
      readFileSync(path.join(testRoot, "state", "generic-provider-credentials", "editable-gateway.key"), "utf8").trim(),
      secret,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the API forwarder sends a generic route only to its configured local endpoint", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "router-generic-forward-"));
  const [upstreamPort, forwarderPort] = await Promise.all([freePort(), freePort()]);
  const state = path.join(testRoot, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "generic-providers.json"), JSON.stringify({
    version: 1,
    providers: [{
      id: "local-gateway",
      displayName: "Local Gateway",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      adapter: "openai-chat",
      headers: {},
      allowPrivate: true,
      enabled: true,
    }],
  }));
  writeFileSync(path.join(state, "user-models.json"), JSON.stringify({
    version: 1,
    models: [{
      slug: "local-gateway/coder-a",
      gatewayModel: "local-gateway-coder-a",
      compHash: "local-gateway-coder-a-user-v1",
      upstreamModel: "coder-a",
      provider: "local-gateway",
      listed: true,
      displayName: "Coder A",
      description: "Test model",
      priority: 1,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
      contextWindow: 131072,
      autoCompact: 110000,
      inputModalities: ["text"],
    }],
  }));

  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "127.0.0.1", resolve);
  });

  const internalKey = "TEST_INTERNAL_KEY";
  const child = spawn(process.execPath, ["src/api-forwarder.mjs"], {
    cwd: root,
    env: environment(testRoot, {
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_QUIET: "1",
    }),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${forwarderPort}/health`, {
          headers: { Authorization: `Bearer ${internalKey}` },
        });
        if (health.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(ready, true, "API forwarder did not start");
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "local-gateway-coder-a",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(observed.url, "/v1/chat/completions");
    assert.equal(observed.authorization, undefined, "the router's internal key must not leave the machine");
    assert.equal(observed.body.model, "coder-a");
  } finally {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});
