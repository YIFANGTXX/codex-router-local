import assert from "node:assert/strict";
import test from "node:test";

import {
  restartManagedRouterFallback,
  startManagedRouterFallback,
} from "../src/router-restart-fallback.mjs";

test("a missing Windows task starts the existing hidden launcher without stopping Codex", async () => {
  const events = [];
  const started = await startManagedRouterFallback({
    platform: "win32",
    state: null,
    launcherPath: "C:\\safe\\router.vbs",
    wrapperPath: "C:\\safe\\router.cmd",
    fileExists: () => true,
    launch: (launcher) => { events.push(`launch:${launcher}`); return {}; },
    waitForHealth: async () => { events.push("health"); return { ok: true }; },
  });
  assert.equal(started, true);
  assert.deepEqual(events, ["launch:C:\\safe\\router.vbs", "health"]);
});

test("an existing identity-verified router is reused instead of launching a duplicate", async () => {
  let launches = 0;
  const started = await startManagedRouterFallback({
    platform: "win32",
    state: { pid: 1234 },
    owns: () => true,
    launcherPath: "C:\\safe\\router.vbs",
    wrapperPath: "C:\\safe\\router.cmd",
    fileExists: () => true,
    launch: () => { launches += 1; return {}; },
    waitForHealth: async () => ({ ok: true }),
  });
  assert.equal(started, true);
  assert.equal(launches, 0);
});

test("the missing-task fallback fails closed without both launcher files or health", async () => {
  await assert.rejects(
    () => startManagedRouterFallback({
      platform: "win32",
      state: null,
      launcherPath: "C:\\safe\\router.vbs",
      wrapperPath: "C:\\safe\\router.cmd",
      fileExists: (target) => target.endsWith(".vbs"),
      launch: () => assert.fail("missing wrapper must not launch"),
    }),
    /launcher.*missing/i,
  );
  await assert.rejects(
    () => startManagedRouterFallback({
      platform: "win32",
      state: null,
      launcherPath: "C:\\safe\\router.vbs",
      wrapperPath: "C:\\safe\\router.cmd",
      fileExists: () => true,
      launch: () => ({}),
      waitForHealth: async () => ({ ok: false, error: "Router is unreachable." }),
    }),
    /Router is unreachable/,
  );
});

test("a launcher spawn failure is reported before waiting for Router health", async () => {
  await assert.rejects(
    () => startManagedRouterFallback({
      platform: "win32",
      state: null,
      launcherPath: "C:\\safe\\router.vbs",
      wrapperPath: "C:\\safe\\router.cmd",
      fileExists: () => true,
      launch: async () => { throw new Error("launcher unavailable"); },
      waitForHealth: async () => assert.fail("a failed launch cannot become healthy"),
    }),
    /launcher unavailable/,
  );
});

test("fallback launcher restarts only an identity-verified managed Windows router", async () => {
  const state = { pid: 1234 };
  let alive = true;
  const events = [];
  const restarted = await restartManagedRouterFallback({
    platform: "win32",
    state,
    owns: () => alive,
    launcherPath: "C:\\safe\\router.vbs",
    fileExists: () => true,
    kill: (pid) => { events.push(`kill:${pid}`); alive = false; },
    launch: (launcher) => { events.push(`launch:${launcher}`); return {}; },
    clearState: () => events.push("clear"),
    waitForHealth: async () => ({ ok: true }),
    stopTimeoutMs: 20,
    pollMs: 1,
  });

  assert.equal(restarted, true);
  assert.deepEqual(events, ["kill:1234", "clear", "launch:C:\\safe\\router.vbs"]);
});

test("fallback launcher refuses an unverified process record", async () => {
  let killed = false;
  const restarted = await restartManagedRouterFallback({
    platform: "win32",
    state: { pid: 1234 },
    owns: () => false,
    launcherPath: "C:\\safe\\router.vbs",
    fileExists: () => true,
    kill: () => { killed = true; },
  });

  assert.equal(restarted, false);
  assert.equal(killed, false);
});
