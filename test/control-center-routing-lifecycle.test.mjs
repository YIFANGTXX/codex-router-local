import test from "node:test";
import assert from "node:assert/strict";

import { createRoutingLifecycle } from "../apps/control-center/electron/routing-lifecycle.mjs";
import {
  ownerIsAlive,
  watchControlCenter,
} from "../src/control-center-watchdog.mjs";

test("visible Control Center mounts a fresh merged catalog and closing restores native mode", async () => {
  const calls = [];
  const lifecycle = createRoutingLifecycle({
    runControl: async (args) => {
      calls.push(["control", ...args]);
      return { stdout: JSON.stringify({ ok: args[0] === "health" }) };
    },
    runScript: async (script, args) => { calls.push([script, ...args]); return { stdout: '{"mode":"router"}' }; },
  });

  await lifecycle.request(true);
  assert.deepEqual(calls, [
    ["control", "health"],
    ["refresh-catalog.mjs"],
    ["config-manager.mjs", "enable"],
    ["catalog.mjs"],
    ["control", "health"],
    ["config-manager.mjs", "status"],
  ]);
  assert.deepEqual(lifecycle.snapshot(), {
    state: "connected",
    connected: true,
    desiredConnected: true,
    restartRequired: true,
  });

  await lifecycle.request(false);
  assert.deepEqual(calls.slice(-2), [
    ["local-gguf.mjs", "stop-all"],
    ["config-manager.mjs", "disable"],
  ]);
  assert.equal(lifecycle.snapshot().state, "native");
  assert.equal(lifecycle.snapshot().connected, false);
});

test("an unhealthy endpoint falls back to the registered service start", async () => {
  const calls = [];
  let healthy = false;
  const lifecycle = createRoutingLifecycle({
    runControl: async (args) => {
      calls.push(["control", ...args]);
      if (args[0] === "service") healthy = true;
      return { stdout: JSON.stringify({ ok: healthy }) };
    },
    runScript: async (script, args) => { calls.push([script, ...args]); return { stdout: '{"mode":"router"}' }; },
  });

  await lifecycle.request(true);
  assert.deepEqual(calls.slice(0, 2), [
    ["control", "health"],
    ["control", "service", "start"],
  ]);
  assert.equal(lifecycle.snapshot().connected, true);
});

test("a transient backend loss is recovered without unmounting the live task", async () => {
  const calls = [];
  let healthy = true;
  const lifecycle = createRoutingLifecycle({
    runControl: async (args) => {
      calls.push(["control", ...args]);
      if (args[0] === "service") healthy = true;
      return { stdout: JSON.stringify({ ok: healthy }) };
    },
    runScript: async (script, args) => { calls.push([script, ...args]); return { stdout: '{"mode":"router"}' }; },
  });

  await lifecycle.request(true);
  healthy = false;
  await lifecycle.ensureHealthy();

  assert.equal(lifecycle.snapshot().state, "connected");
  assert.equal(lifecycle.snapshot().connected, true);
  assert.equal(lifecycle.snapshot().desiredConnected, true);
  assert.deepEqual(calls.slice(-3), [
    ["control", "service", "start"],
    ["control", "health"],
    ["config-manager.mjs", "status"],
  ]);
  assert.equal(calls.some((call) => call.includes("disable") || call.includes("stop-all")), false);
});

test("a close requested during activation is serialized after the mount", async () => {
  let releaseRefresh;
  let refreshStarted;
  const refreshReady = new Promise((resolve) => { refreshStarted = resolve; });
  const refreshBlocked = new Promise((resolve) => { releaseRefresh = resolve; });
  const calls = [];
  const lifecycle = createRoutingLifecycle({
    runControl: async (args) => { calls.push(["control", ...args]); return { stdout: '{"ok":true}' }; },
    runScript: async (script, args) => {
      calls.push([script, ...args]);
      if (script === "refresh-catalog.mjs") {
        refreshStarted();
        await refreshBlocked;
      }
      return { stdout: '{"mode":"router"}' };
    },
  });

  const opening = lifecycle.request(true);
  await refreshReady;
  const closing = lifecycle.request(false);
  releaseRefresh();
  await Promise.all([opening, closing]);

  assert.equal(lifecycle.snapshot().state, "native");
  assert.equal(lifecycle.snapshot().desiredConnected, false);
  assert.deepEqual(calls.slice(-2), [
    ["local-gguf.mjs", "stop-all"],
    ["config-manager.mjs", "disable"],
  ]);
});

test("a resolved connect command cannot claim success without the mounted config", async () => {
  const lifecycle = createRoutingLifecycle({
    runControl: async () => ({ stdout: '{"ok":true}' }),
    runScript: async () => ({ stdout: '{"mode":"native"}' }),
  });
  const result = await lifecycle.request(true);
  assert.equal(result.state, "error");
  assert.equal(result.connected, false);
  assert.match(result.error, /尚未挂载/);
});

test("failed backend recovery reports an error instead of silently claiming native success", async () => {
  let healthy = true;
  const lifecycle = createRoutingLifecycle({
    runControl: async () => ({ stdout: JSON.stringify({ ok: healthy }) }),
    runScript: async () => ({ stdout: '{"mode":"router"}' }),
  });
  await lifecycle.request(true);
  healthy = false;
  await lifecycle.ensureHealthy();
  assert.equal(lifecycle.snapshot().connected, false);
  assert.equal(lifecycle.snapshot().state, "error");
  assert.match(lifecycle.snapshot().error, /后台恢复失败/);
});

test("a failed activation rolls back to native configuration", async () => {
  const calls = [];
  const lifecycle = createRoutingLifecycle({
    runControl: async () => {},
    runScript: async (script, args) => {
      calls.push([script, ...args]);
      if (script === "catalog.mjs") throw new Error("publication failed");
    },
  });

  await lifecycle.request(true);
  assert.equal(lifecycle.snapshot().state, "error");
  assert.equal(lifecycle.snapshot().connected, false);
  assert.match(lifecycle.snapshot().error, /publication failed/);
  assert.deepEqual(calls.at(-1), ["config-manager.mjs", "disable"]);
});

test("watchdog accepts only the exact owner with a fresh heartbeat", () => {
  const base = {
    running: true,
    pid: 4321,
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
  const now = Date.parse("2026-09-07T00:00:04.000Z");
  assert.equal(ownerIsAlive({ ownerPid: 4321, lifecycle: base, now }), true);
  assert.equal(ownerIsAlive({ ownerPid: 1234, lifecycle: base, now }), false);
  assert.equal(ownerIsAlive({ ownerPid: 4321, lifecycle: base, now: now + 9_000 }), false);
});

test("watchdog restores native mode after the Control Center owner exits", async () => {
  let reads = 0;
  let disables = 0;
  let localStops = 0;
  const result = await watchControlCenter({
    ownerPid: 4321,
    readLifecycle: () => {
      reads += 1;
      return reads === 1
        ? { running: true, pid: 4321, updatedAt: "2026-09-07T00:00:00.000Z" }
        : { running: false, pid: null, updatedAt: "2026-09-07T00:00:00.000Z" };
    },
    now: () => Date.parse("2026-09-07T00:00:01.000Z"),
    sleep: async () => {},
    disable: async () => { disables += 1; return true; },
    stopLocal: async () => { localStops += 1; return true; },
  });
  assert.deepEqual(result, { restored: true, localStopped: true });
  assert.equal(disables, 1);
  assert.equal(localStops, 1);
});
