import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  lifecycleStatePath,
  queryLifecycleState,
} from "../apps/control-center/electron/lifecycle-state.mjs";
import { SOURCE_ROOT } from "./paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const HEARTBEAT_MAX_AGE_MS = 8_000;
const POLL_MS = 1_000;

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function ownerIsAlive({
  ownerPid,
  lifecycle,
  now = Date.now(),
  maxAgeMs = HEARTBEAT_MAX_AGE_MS,
} = {}) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) return false;
  if (!lifecycle?.running || lifecycle.pid !== ownerPid) return false;
  const updatedAt = Date.parse(lifecycle.updatedAt || "");
  return Number.isFinite(updatedAt) && now - updatedAt <= maxAgeMs;
}

function disableManagedIntegration() {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "config-manager.mjs"), "disable"],
    {
      cwd: SOURCE_ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      timeout: 120_000,
    },
  );
  return !result.error && result.status === 0;
}

function stopLocalModels() {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "local-gguf.mjs"), "stop-all"],
    {
      cwd: SOURCE_ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      timeout: 30_000,
    },
  );
  return !result.error && result.status === 0;
}

export async function watchControlCenter({
  ownerPid,
  lifecycleFile = lifecycleStatePath(),
  readLifecycle = queryLifecycleState,
  isRunning = processIsRunning,
  disable = disableManagedIntegration,
  stopLocal = stopLocalModels,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollMs = POLL_MS,
} = {}) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw new Error("A valid Control Center owner PID is required.");
  }
  while (true) {
    const lifecycle = readLifecycle(lifecycleFile, { isRunning });
    if (!ownerIsAlive({ ownerPid, lifecycle, now: now() })) {
      // The watchdog is intentionally one-shot. It outlives the Electron
      // process, restores native Codex configuration, and then retires.
      const localStopped = await stopLocal() === true;
      return { restored: await disable() === true, localStopped };
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const ownerPid = Number(process.argv[2]);
  try {
    const result = await watchControlCenter({ ownerPid });
    process.exitCode = result.restored ? 0 : 1;
  } catch {
    // Never print child-process stderr here: a config refusal can contain a
    // user-owned endpoint. The Control Center reports its own normal shutdown
    // result, and this process exists only as crash recovery.
    process.exitCode = 1;
  }
}
