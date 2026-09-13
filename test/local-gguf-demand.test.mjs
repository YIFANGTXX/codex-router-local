import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalModelDemand, localDemandAllowed, managedLocalModel } from "../src/local-gguf-demand.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { PORTS } from "../src/paths.mjs";

const local = { id: "qwen", modelId: "qwen-local", port: 4268 };
const model = { requestProfile: "qwen38-local", upstreamModel: local.modelId };
const provider = { id: "local-gguf-qwen", generic: true, enabled: true, allowPrivate: true, baseUrl: "http://127.0.0.1:4268/v1" };
const registry = { models: [local] };
function demand(overrides = {}) {
  return createLocalModelDemand({
    readRegistry: () => registry,
    runtimeStatus: async () => null,
    allowed: () => true,
    start: async () => {},
    ...overrides,
  });
}

test("cold local requests wait for one shared startup, then reuse the running model", async () => {
  let starts = 0;
  let ready = false;
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const ensure = demand({
    runtimeStatus: async () => ready ? { id: local.id, status: "running" } : null,
    start: async () => { starts++; await blocked; ready = true; },
  });
  let forwarded = 0;
  const send = async () => { await ensure(model, provider); assert.equal(ready, true); forwarded++; };
  const requests = [send(), send(), send()];
  await delay(5);
  assert.equal(starts, 1);
  assert.equal(forwarded, 0);
  finish();
  await Promise.all(requests);
  await send();
  assert.equal(starts, 1);
  assert.equal(forwarded, 4);
});

test("startup is restricted to the exact registered loopback destination", async () => {
  for (const change of [
    { baseUrl: "https://example.com/v1" }, { baseUrl: "http://127.0.0.1:9999/v1" },
    { allowPrivate: false }, { enabled: false },
  ]) assert.equal(managedLocalModel(model, { ...provider, ...change }, registry), undefined);
  let starts = 0;
  const ensure = demand({ start: async () => { starts++; } });
  await assert.rejects(ensure(model, { ...provider, baseUrl: "https://example.com/v1" }), { status: 400 });
  assert.equal(await ensure({ upstreamModel: "gpt-native" }, { id: "openai" }), false);
  assert.equal(starts, 0);
});

test("closed, stale, or disconnected Control Center cannot start a local model", async () => {
  const now = Date.now();
  const lifecycle = { running: true, ready: true, visible: true, updatedAt: new Date(now).toISOString() };
  const readConfig = () => `openai_base_url = "${callerBaseUrl(PORTS.router, "a".repeat(32))}"\n`;
  assert.equal(localDemandAllowed({ lifecycle, readConfig, now }), true);
  for (const change of [{ running: false }, { ready: false }, { visible: false }, { updatedAt: new Date(now - 9000).toISOString() }]) {
    assert.equal(localDemandAllowed({ lifecycle: { ...lifecycle, ...change }, readConfig, now }), false);
  }
  assert.equal(localDemandAllowed({ lifecycle, readConfig: () => 'model = "gpt-native"', now }), false);
  assert.equal(localDemandAllowed({ lifecycle, readConfig: () => { throw new Error("missing"); }, now }), false);
  let starts = 0;
  await assert.rejects(demand({ allowed: () => false, start: async () => { starts++; } })(model, provider), { status: 400 });
  assert.equal(starts, 0);
});

test("a canceled caller does not cancel another caller's shared startup", async () => {
  let finish;
  let startupSignal;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const ensure = demand({ start: async (_id, options) => { startupSignal = options.signal; await blocked; } });
  const caller = new AbortController();
  const first = assert.rejects(ensure(model, provider, caller.signal), { name: "AbortError" });
  const second = ensure(model, provider);
  await delay(5);
  caller.abort();
  await first;
  assert.equal(startupSignal.aborted, false);
  finish();
  assert.equal(await second, true);
});

test("canceling every caller cancels cold startup", async () => {
  let startupSignal;
  const ensure = demand({ start: async (_id, { signal }) => {
    startupSignal = signal;
    await delay(5000, undefined, { signal });
  } });
  const caller = new AbortController();
  const request = assert.rejects(ensure(model, provider, caller.signal), { name: "AbortError" });
  await delay(5);
  caller.abort();
  await request;
  assert.equal(startupSignal.aborted, true);
});

test("startup failure is actionable, sanitized, non-fallback and can be retried", async () => {
  let tries = 0;
  const ensure = demand({ start: () => {
    if (++tries === 1) throw new Error("secret-sensitive-runtime-stderr");
  } });
  await assert.rejects(ensure(model, provider), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /启动失败/);
    assert.doesNotMatch(error.message, /secret-sensitive/);
    return true;
  });
  assert.equal(await ensure(model, provider), true);
});

test("on-demand startup does not evict another active model", async () => {
  let starts = 0;
  const ensure = demand({
    runtimeStatus: async () => ({ id: "other", status: "running" }),
    start: () => { starts++; },
  });
  await assert.rejects(ensure(model, provider), { status: 400 });
  assert.equal(starts, 0);
});

test("an unreadable local registry is not converted into remote fallback", async () => {
  const ensure = demand({ readRegistry: () => { throw new Error("sensitive-file-details"); } });
  await assert.rejects(ensure(model, provider), (error) => {
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /sensitive-file-details/);
    return true;
  });
});
