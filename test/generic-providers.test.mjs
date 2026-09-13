import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "generic-provider-test-"));
process.env.HOME = testRoot;
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "state", "user-models.json");
process.env.CODEX_ROUTER_SERVICE_PLATFORM = "linux";
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  GENERIC_PROVIDERS_PATH,
  addGenericProvider,
  genericForwardTimeoutMs,
  getGenericProvider,
  genericProviderDescriptor,
  listGenericProviders,
  requestGenericProvider,
  readGenericProviders,
  removeGenericProvider,
  runGenericProviderCli,
  setGenericProviderEnabled,
  testGenericProvider,
  testGenericProviderInput,
  updateGenericProvider,
} = await import("../src/generic-providers.mjs");
const {
  addCredentialReference,
  addGenericProviderCredentialReference,
  readProviderCredentialStore,
} = await import("../src/provider-credential-store.mjs");
const {
  genericProviderCredentialPath,
  writeGenericProviderCredential,
} = await import("../src/provider-credentials.mjs");
const { LOG_PATH } = await import("../src/paths.mjs");
const { createSupportBundle } = await import("../src/support-bundle.mjs");
const { discoverGenericProviderModels } = await import("../src/model-discovery.mjs");
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("generic provider CRUD is versioned, atomic and redacted", () => {
  const added = addGenericProvider({
    id: "local-vllm",
    displayName: "Local vLLM",
    description: "A local OpenAI-compatible server",
    baseUrl: "https://inference.example.test/v1",
    adapter: "openai-chat",
    headers: { "X-Organization": "test-org" },
    credentialRef: "cred_local_vllm_01",
  });
  assert.equal(added.id, "local-vllm");
  assert.deepEqual(added.headers, { "X-Organization": "[redacted]" });
  assert.deepEqual(readGenericProviders()[0].headers, { "X-Organization": "test-org" });
  // Windows does not expose POSIX permission bits. The private writer still
  // uses the restrictive mode on POSIX, while the ACL is the Windows boundary.
  if (process.platform !== "win32") {
    assert.equal(statSync(GENERIC_PROVIDERS_PATH).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(GENERIC_PROVIDERS_PATH, "utf8")).version, 1);

  const listed = listGenericProviders();
  assert.deepEqual(listed[0].headers, { "X-Organization": "[redacted]" });
  const descriptor = genericProviderDescriptor("local-vllm");
  assert.deepEqual(descriptor, {
    id: "local-vllm",
    displayName: "Local vLLM",
    kind: "openai-compatible",
    ownedBy: "local-vllm",
    baseUrl: "https://inference.example.test/v1",
    adapter: "openai-chat",
    protocol: "openai",
    headers: { "X-Organization": "[redacted]" },
    allowPrivate: false,
    credentialRef: "cred_local_vllm_01",
    generic: true,
    enabled: true,
  });
});

test("generic provider edits do not erase fields omitted by the CLI", () => {
  const updated = updateGenericProvider("local-vllm", { displayName: "Local vLLM (edited)" });
  assert.equal(updated.displayName, "Local vLLM (edited)");
  assert.equal(getGenericProvider("local-vllm").baseUrl, "https://inference.example.test/v1");
  assert.equal(getGenericProvider("local-vllm").credentialRef, "cred_local_vllm_01");
  assert.equal(setGenericProviderEnabled("local-vllm", false).enabled, false);
  assert.equal(getGenericProvider("local-vllm").enabled, false);
  assert.deepEqual(removeGenericProvider("local-vllm"), { removed: "local-vllm", remaining: 0 });
});

test("private endpoints and secret transport headers require explicit handling", () => {
  assert.throws(
    () => addGenericProvider({
      id: "loopback-default",
      displayName: "Loopback",
      baseUrl: "http://127.0.0.1:8000/v1",
    }),
    /allowPrivate=true/,
  );
  const local = addGenericProvider({
    id: "loopback-explicit",
    displayName: "Loopback",
    baseUrl: "http://127.0.0.1:8000/v1",
    allowPrivate: true,
  });
  assert.equal(local.allowPrivate, true);
  assert.throws(
    () => addGenericProvider({
      id: "secret-header",
      displayName: "Invalid",
      baseUrl: "https://inference.example.test/v1",
      headers: { Authorization: "secret" },
    }),
    /reserved for credential/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "deepseek",
      displayName: "Invalid",
      baseUrl: "https://inference.example.test/v1",
    }),
    /already used by the built-in registry/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "ipv6-link-local",
      displayName: "Invalid",
      baseUrl: "https://[fe90::1]/v1",
    }),
    /private or loopback|allowPrivate=true/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "ipv4-mapped-loopback",
      displayName: "Invalid",
      baseUrl: "https://[::ffff:7f00:1]/v1",
    }),
    /private or loopback|allowPrivate=true/,
  );
});

test("generic provider test checks private resolution and never prints headers", async () => {
  const calls = [];
  const result = await testGenericProvider("loopback-explicit", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/models");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test("an unsaved connection can be checked without persisting its address or key", async () => {
  const calls = [];
  const secret = "UNSAVED_PROBE_KEY";
  const before = readFileSync(GENERIC_PROVIDERS_PATH, "utf8");
  const result = await testGenericProviderInput({
    baseUrl: "https://probe.example.test/v1",
    adapter: "openai-responses",
    apiKey: secret,
  }, {
    lookup: async () => ["8.8.8.8"],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reachable, true);
  assert.equal(result.status, 200);
  assert.equal(Number.isFinite(result.elapsedMs), true);
  assert.equal(calls[0].url, "https://probe.example.test/v1/models");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(readFileSync(GENERIC_PROVIDERS_PATH, "utf8"), before);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("only a private loopback Qwen route removes the generic forwarding deadline", () => {
  const local = { baseUrl: "http://127.0.0.1:4268/v1", allowPrivate: true };
  const remote = { baseUrl: "https://provider.example.test/v1", allowPrivate: false };
  assert.equal(genericForwardTimeoutMs({ requestProfile: "qwen38-local" }, local), null);
  assert.equal(genericForwardTimeoutMs({ requestProfile: "qwen38-local" }, remote), 120_000);
  assert.equal(genericForwardTimeoutMs({ requestProfile: "qwen38-community" }, local), 120_000);
  assert.equal(genericForwardTimeoutMs({ requestProfile: "qwen38-local" }, { ...local, allowPrivate: false }), 120_000);
  assert.match(
    readFileSync(path.join(root, "src", "api-forwarder.mjs"), "utf8"),
    /timeoutMs: genericForwardTimeoutMs\(normalized\.model, normalized\.provider\)/,
  );
});

test("local generic requests have no total timeout but still follow caller cancellation", async () => {
  addGenericProvider({
    id: "local-slow-stream",
    displayName: "Local slow stream",
    baseUrl: "http://127.0.0.1:4268/v1",
    allowPrivate: true,
  });
  const caller = new AbortController();
  let upstreamSignal;
  await requestGenericProvider("local-slow-stream", "/chat/completions", {
    timeoutMs: null,
    signal: caller.signal,
    lookup: async () => ["127.0.0.1"],
    fetchImpl: async (_url, options) => {
      upstreamSignal = options.signal;
      return { status: 200, headers: new Headers() };
    },
  });
  assert.equal(upstreamSignal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(upstreamSignal.aborted, false, "a silent prefill was timed out");
  caller.abort();
  assert.equal(upstreamSignal.aborted, true, "Codex cancellation did not reach the model");
});

test("a real local provider may finish after a silent prefill without a timeout", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end("data: [DONE]\n\n");
    }, 90);
  });
  const port = await listen(server);
  try {
    addGenericProvider({
      id: "local-prefill-http",
      displayName: "Local prefill HTTP",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      allowPrivate: true,
    });
    const caller = new AbortController();
    const started = Date.now();
    const { response, dispatcher } = await requestGenericProvider("local-prefill-http", "/models", {
      timeoutMs: null,
      signal: caller.signal,
    });
    try {
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "data: [DONE]\n\n");
      assert.ok(Date.now() - started >= 70, "fixture did not exercise a silent prefill");
    } finally {
      await dispatcher?.close();
    }
  } finally {
    await closeServer(server);
  }
});

test("generic requests revalidate DNS, reject redirects, and bound response reads", async () => {
  addGenericProvider({
    id: "remote-boundary",
    displayName: "Remote boundary",
    baseUrl: "https://provider.example.test/v1",
  });
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/models", {
      lookup: async () => ["192.168.10.12"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /private or link-local/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "https://attacker.example/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /request paths must be relative/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/../admin", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => { throw new Error("escaped base path reached fetch"); },
    }),
    /cannot escape the configured baseUrl path/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: false, status: 302, body: { cancel: async () => undefined } }),
    }),
    /redirects are disabled/,
  );
  await assert.rejects(
    () => testGenericProvider("remote-boundary", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "65537" }),
      }),
    }),
    /65536-byte|read limit/,
  );
});

test("generic credential references never enter descriptors or logs", async () => {
  addGenericProvider({
    id: "credential-boundary",
    displayName: "Credential boundary",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_provider_01",
    headers: { "X-Organization": "safe-metadata" },
  });
  assert.equal(JSON.stringify(listGenericProviders()).includes("TEST_GENERIC_PROVIDER_TOKEN"), false);
  await assert.rejects(
    () => requestGenericProvider("credential-boundary", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Credential cred_generic_provider_01 is unavailable/,
  );
});

test("generic requests fail closed when a credential is unavailable or not an API key", async () => {
  addGenericProvider({
    id: "missing-credential",
    displayName: "Missing credential",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_missing_01",
  });
  await assert.rejects(
    () => requestGenericProvider("missing-credential", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Credential cred_generic_missing_01 is unavailable/,
  );

  addGenericProvider({
    id: "account-credential",
    displayName: "Account credential",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_account_01",
  });
  await assert.rejects(
    () => requestGenericProvider("account-credential", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Credential cred_generic_account_01 is unavailable/,
  );
});

test("public APIs confine a generic credential to its permitted endpoint", async () => {
  const providerId = "public-api-provider";
  const secret = "TEST_GENERIC_PUBLIC_API_TOKEN_82f6f31a";
  const permittedRequests = [];
  const trappedRequests = [];
  const trap = createServer((request, response) => {
    trappedRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const trapPort = await listen(trap);
  const permitted = createServer((request, response) => {
    permittedRequests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === "/v1/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${trapPort}/stolen` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });
  const permittedPort = await listen(permitted);

  try {
    assert.throws(
      () => addCredentialReference({ providerId, kind: "api_key", secretRef: { type: "provider-file" } }),
      /Invalid providerId/,
      "the built-in credential API must remain registry-bound",
    );
    assert.throws(
      () => addGenericProviderCredentialReference({ providerId: "deepseek" }),
      /already used by the built-in registry/,
      "the generic credential API must not bypass built-in validation",
    );

    const credential = addGenericProviderCredentialReference({
      id: "cred_public_generic_credential_01",
      providerId,
      label: "Public API fixture",
    });
    const credentialPath = writeGenericProviderCredential(providerId, secret);
    assert.equal(credentialPath, genericProviderCredentialPath(providerId));
    if (process.platform !== "win32") assert.equal(statSync(credentialPath).mode & 0o777, 0o600);

    const provider = addGenericProvider({
      id: providerId,
      displayName: "Public API provider",
      baseUrl: `http://127.0.0.1:${permittedPort}/v1`,
      allowPrivate: true,
      credentialRef: credential.id,
    });
    const result = await testGenericProvider(providerId);
    assert.equal(result.ok, true);
    assert.deepEqual(permittedRequests, [{
      url: "/v1/models",
      authorization: `Bearer ${secret}`,
    }]);

    const discovery = await discoverGenericProviderModels(providerId, {
      cache: false,
      proxyResolvesDestination: false,
    });
    assert.deepEqual(discovery.discovered, []);
    assert.equal(permittedRequests.length, 2);
    assert.equal(permittedRequests[1].url, "/v1/models");
    assert.equal(permittedRequests[1].authorization, `Bearer ${secret}`);

    await assert.rejects(
      () => requestGenericProvider(providerId, "/redirect"),
      /redirects are disabled/,
    );
    assert.equal(trappedRequests.length, 0, "a redirect received the generic credential");
    assert.equal(permittedRequests.length, 3);
    assert.ok(permittedRequests.every((request) => request.authorization === `Bearer ${secret}`));

    let cliOutput = "";
    await runGenericProviderCli(["show", providerId, "--json"], {
      output: { write(chunk) { cliOutput += chunk; return true; } },
    });
    const publicSurfaces = JSON.stringify({
      credential,
      provider,
      descriptor: genericProviderDescriptor(providerId),
      listed: listGenericProviders(),
      result,
      discovery,
      cliOutput,
      credentialStore: readProviderCredentialStore(),
    });
    assert.equal(publicSurfaces.includes(secret), false, "a descriptor or public output exposed the credential");

    writeFileSync(LOG_PATH, `upstream diagnostic accidentally included ${secret}\n`, { mode: 0o600 });
    const bundlePath = path.join(testRoot, "generic-provider-support.json");
    createSupportBundle({ includeLogs: true, output: bundlePath });
    assert.equal(readFileSync(bundlePath, "utf8").includes(secret), false, "support output exposed the credential");
  } finally {
    await Promise.all([closeServer(permitted), closeServer(trap)]);
  }
});

test("providers CLI exposes generic CRUD with sanitized JSON", () => {
  const env = {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex-cli"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state-cli"),
    MODEL_ROUTER_USER_MODELS: path.join(testRoot, "state-cli", "user-models.json"),
  };
  mkdirSync(env.CODEX_ROUTER_STATE_DIR, { recursive: true });
  const add = spawnSync(process.execPath, ["src/providers.mjs", "generic", "add", "cli-test", "--name", "CLI Test", "--base-url", "https://cli.example.test/v1", "--header", "X-Org=demo", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout);
  assert.equal(added.provider.id, "cli-test");
  assert.equal(added.provider.headers["X-Org"], "[redacted]");
  const list = spawnSync(process.execPath, ["src/providers.mjs", "generic", "list", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).providers[0].id, "cli-test");
});
