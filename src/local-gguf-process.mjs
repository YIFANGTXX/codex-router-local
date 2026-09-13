import { spawnSync } from "node:child_process";
import { processCommandLine, processStartIdentity } from "./process-identity.mjs";

export function findLocalListener(port, { spawn = spawnSync } = {}) {
  if (process.platform !== "win32" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$p = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1; [Console]::Out.Write($p.OwningProcess)`,
  ], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const pid = Number(String(result.stdout || "").trim());
  return result.status === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function identifyRegisteredLlama(model, {
  findPid = findLocalListener, commandLine = processCommandLine, identity = processStartIdentity,
} = {}) {
  if (!model.serverPath) return undefined;
  const pid = findPid(model.port);
  if (!pid) return undefined;
  const command = commandLine(pid);
  const processIdentity = identity(pid);
  if (!command || !processIdentity) return undefined;
  const normalized = command.toLowerCase().replaceAll("/", "\\");
  if (![model.serverPath, model.modelPath].every((value) => normalized.includes(value.toLowerCase().replaceAll("/", "\\")))
    || !command.includes(model.modelId)) return undefined;
  // The caller must additionally authenticate /health and /v1/models with
  // this registered model's private key before adopting the process.
  return { pid, processIdentity };
}
