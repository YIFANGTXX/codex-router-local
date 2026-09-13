import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STATE_DIR } from "./paths.mjs";
import {
  clearServiceProcessState,
  readServiceProcessState,
  serviceProcessOwns,
} from "./service-process.mjs";
import { waitForRouterHealth } from "./router-health.mjs";

const SELF = fileURLToPath(import.meta.url);
const LAUNCHER_PATH = path.join(STATE_DIR, "start-codex-router-hidden.vbs");
const WRAPPER_PATH = path.join(STATE_DIR, "start-codex-router.cmd");
const STOP_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function launchHiddenRouter(launcher) {
  return new Promise((resolve, reject) => {
    // WMI creates the service outside the short-lived CLI/Electron command's
    // Windows job. CREATE_NEW_PROCESS_GROUP alone does not escape that job:
    // the service can look healthy, then disappear when its caller is cleaned up.
    // The existing wrapper still supplies all installed runtime/environment settings.
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      '$ErrorActionPreference = "Stop"; $launcher = $env:MODEL_ROUTER_BACKGROUND_LAUNCHER; ' +
      '$command = [char]34 + $env:SystemRoot + "\\System32\\cmd.exe" + [char]34 + " /D /C " + [char]34 + [char]34 + $launcher + [char]34 + [char]34; ' +
      '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ' +
      '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; ProcessStartupInformation = $startup }; ' +
      'if ($result.ReturnValue -ne 0) { exit 1 }',
    ], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, MODEL_ROUTER_BACKGROUND_LAUNCHER: path.join(path.dirname(launcher), "start-codex-router.cmd") },
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Windows could not create the independent local Router process."));
    });
  });
}

// A Control Center can be installed with working launchers even when the
// current Windows account cannot register a Scheduled Task. Starting from the
// existing hidden launcher restores the explicit Connect button without
// installing a task, changing Codex configuration, or stopping any process.
export async function startManagedRouterFallback({
  platform = process.platform,
  state = readServiceProcessState(),
  owns = serviceProcessOwns,
  launcherPath = LAUNCHER_PATH,
  wrapperPath = WRAPPER_PATH,
  fileExists = existsSync,
  launch = launchHiddenRouter,
  waitForHealth = waitForRouterHealth,
  timeoutMs = 300_000,
} = {}) {
  if (platform !== "win32") return false;
  if (!fileExists(launcherPath) || !fileExists(wrapperPath)) {
    throw new Error("Router launcher is missing; repair the local installation before connecting.");
  }
  if (!state || !owns(state, { platform })) {
    const child = await launch(launcherPath);
    if (child?.error) throw child.error;
  }
  const health = await waitForHealth({ timeoutMs });
  if (health?.ok !== true) {
    throw new Error(health?.error || "The local Router did not become ready after startup.");
  }
  return true;
}

export async function restartManagedRouterFallback({
  platform = process.platform,
  state = readServiceProcessState(),
  owns = serviceProcessOwns,
  launcherPath = LAUNCHER_PATH,
  fileExists = existsSync,
  kill = (pid) => spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  }),
  launch = launchHiddenRouter,
  clearState = clearServiceProcessState,
  waitForHealth = waitForRouterHealth,
  stopTimeoutMs = STOP_TIMEOUT_MS,
  pollMs = POLL_MS,
} = {}) {
  if (platform !== "win32" || !state || !owns(state, { platform }) || !fileExists(launcherPath)) {
    return false;
  }

  kill(state.pid);
  const deadline = Date.now() + stopTimeoutMs;
  while (owns(state, { platform }) && Date.now() < deadline) {
    await sleep(pollMs);
  }
  if (owns(state, { platform })) {
    throw new Error("The running local router could not be stopped safely.");
  }

  clearState();
  const child = await launch(launcherPath);
  if (child?.error) throw child.error;
  const health = await waitForHealth({ timeoutMs: 300_000 });
  if (health?.ok !== true) {
    throw new Error(health?.error || "The local router did not become ready after restart.");
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    const restarted = await restartManagedRouterFallback();
    process.exit(restarted ? 0 : 3);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
