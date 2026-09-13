import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addConnection,
  addConnectionModels,
  connectionsSnapshot,
  deleteConnection,
  setConnectionCredential,
  setConnectionEnabled,
  updateConnection,
} from "./connections.mjs";
import { privateFileIsProtected, writePrivateFile, writePrivateJson } from "./file-security.mjs";
import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { identifyRegisteredLlama } from "./local-gguf-process.mjs";
import { processStartIdentity } from "./process-identity.mjs";

const SELF = fileURLToPath(import.meta.url);
const SERVER = path.join(SOURCE_ROOT, "src", "local_gguf_server.py");
const REGISTRY_PATH = process.env.MODEL_ROUTER_LOCAL_GGUF_REGISTRY
  || path.join(STATE_DIR, "local-gguf-models.json");
const RUNTIME_PATH = process.env.MODEL_ROUTER_LOCAL_GGUF_RUNTIME
  || path.join(STATE_DIR, "local-gguf-runtime.json");
const SECRETS_DIR = path.join(STATE_DIR, "local-gguf-secrets");
const LAUNCH_DIR = path.join(STATE_DIR, "local-gguf-launch");
const LOG_DIR = path.join(STATE_DIR, "local-gguf-logs");
const DEFAULT_LLAMA_SERVER = process.env.MODEL_ROUTER_LLAMA_SERVER_PATH
  || path.join(STATE_DIR, "runtimes", "llama-b10435-cuda13.3", "llama-server.exe");
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+\/-]{0,200}$/;
const LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_DIRECTORIES = 2_500;
const MAX_DISCOVERY_RESULTS = 100;
const REASONING_EFFORTS = new Set(["low", "medium", "xhigh"]);

function cleanText(value, label, limit = 240) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > limit || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function integer(value, label, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function decimal(value, label, minimum, maximum) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function localId(value) {
  const result = cleanText(value, "Local model id", 64).toLowerCase();
  if (!LOCAL_ID.test(result)) throw new Error("Local model id contains unsupported characters.");
  return result;
}

function upstreamModelId(value) {
  const result = cleanText(value, "Model id", 201);
  if (!MODEL_ID.test(result)) throw new Error("Model id contains unsupported characters.");
  return result;
}

function existingFile(value, label, { extension } = {}) {
  const candidate = cleanText(value, label, 4_096);
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path.`);
  let resolved;
  try {
    resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) throw new Error();
  } catch {
    throw new Error(`${label} does not exist.`);
  }
  if (extension && path.extname(resolved).toLowerCase() !== extension) {
    throw new Error(`${label} must be a ${extension} file.`);
  }
  return resolved;
}

function existingDirectory(value, label) {
  const candidate = cleanText(value, label, 4_096);
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path.`);
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isDirectory()) throw new Error();
    return resolved;
  } catch {
    throw new Error(`${label} does not exist.`);
  }
}

function parseRegistry(raw) {
  if (!raw) return { version: 1, models: [] };
  if (!raw || raw.version !== 1 || !Array.isArray(raw.models)) {
    throw new Error("Local GGUF registry is invalid.");
  }
  const seen = new Set();
  const models = raw.models.map((entry) => {
    const model = validateModel(entry, { verifyPaths: false });
    if (seen.has(model.id)) throw new Error(`Duplicate local model id: ${model.id}`);
    seen.add(model.id);
    return model;
  });
  return { version: 1, models };
}

function validateModel(input, { verifyPaths = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Local model entry must be an object.");
  }
  const id = localId(input.id);
  const storedPath = (value, label) => {
    const result = cleanText(value, label, 4_096);
    if (!path.isAbsolute(result)) throw new Error(`${label} must be an absolute path.`);
    return path.normalize(result);
  };
  const modelPath = verifyPaths
    ? existingFile(input.modelPath, "GGUF model", { extension: ".gguf" })
    : storedPath(input.modelPath, "GGUF model");
  const pythonPath = verifyPaths
    ? existingFile(input.pythonPath, "Python executable")
    : storedPath(input.pythonPath, "Python executable");
  const dependenciesPath = verifyPaths
    ? existingDirectory(input.dependenciesPath, "llama-cpp dependencies")
    : storedPath(input.dependenciesPath, "llama-cpp dependencies");
  if (verifyPaths && !existsSync(path.join(dependenciesPath, "llama_cpp", "__init__.py"))) {
    throw new Error("llama-cpp-python is missing from the selected dependencies folder.");
  }
  const mmprojPath = input.mmprojPath
    ? (verifyPaths
        ? existingFile(input.mmprojPath, "Vision projection", { extension: ".gguf" })
        : storedPath(input.mmprojPath, "Vision projection"))
    : null;
  const requestedServerPath = input.serverPath || (existsSync(DEFAULT_LLAMA_SERVER) ? DEFAULT_LLAMA_SERVER : null);
  const serverPath = requestedServerPath
    ? (verifyPaths
        ? existingFile(requestedServerPath, "llama.cpp server", { extension: ".exe" })
        : storedPath(requestedServerPath, "llama.cpp server"))
    : null;
  const thinkingEnabled = input.thinkingEnabled === true;
  const reasoningEffort = cleanText(input.reasoningEffort || "xhigh", "Reasoning effort", 16);
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error("Reasoning effort must be low, medium, or xhigh.");
  }
  return {
    id,
    displayName: cleanText(input.displayName || path.basename(modelPath, ".gguf"), "Display name", 120),
    modelId: upstreamModelId(input.modelId || id),
    modelPath,
    pythonPath,
    dependenciesPath,
    mmprojPath,
    serverPath,
    runtimeKind: serverPath ? "llama-server" : "python-llama-cpp",
    inputModalities: mmprojPath ? ["text", "image"] : ["text"],
    thinkingEnabled,
    reasoningEffort,
    reasoningLevels: thinkingEnabled ? ["low", "medium", "xhigh"] : [],
    gpuLayers: integer(input.gpuLayers ?? 24, "GPU layers", 0, 999),
    contextWindow: integer(input.contextWindow ?? 4096, "Context window", 256, 1_000_000),
    maxOutputTokens: integer(input.maxOutputTokens ?? 1024, "Maximum output tokens", 1, 131_072),
    temperature: decimal(input.temperature ?? (thinkingEnabled ? 1 : 0.7), "Temperature", 0, 2),
    topP: decimal(input.topP ?? (thinkingEnabled ? 0.95 : 0.8), "Top P", 0, 1),
    topK: integer(input.topK ?? 20, "Top K", 0, 1_000),
    minP: decimal(input.minP ?? 0, "Min P", 0, 1),
    repeatPenalty: decimal(input.repeatPenalty ?? 1, "Repeat penalty", 0.01, 10),
    frequencyPenalty: decimal(input.frequencyPenalty ?? 0, "Frequency penalty", 0, 2),
    presencePenalty: decimal(input.presencePenalty ?? 0, "Presence penalty", 0, 2),
    stopSequences: Array.isArray(input.stopSequences)
      ? input.stopSequences.map((value) => cleanText(value, "Stop sequence", 120)).slice(0, 8)
      : ["</s>"],
    port: integer(input.port ?? 4268, "Port", 1024, 65_535),
    tuningPreset: cleanText(input.tuningPreset || "qwen38-zerorefusal-codex", "Tuning preset", 80),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
  };
}

export function readLocalGgufRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { version: 1, models: [] };
  const stat = statSync(REGISTRY_PATH);
  if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) throw new Error("Local GGUF registry is too large.");
  try {
    return parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Local GGUF registry is not valid JSON.");
    throw error;
  }
}

function writeRegistry(models) {
  return writePrivateJson(REGISTRY_PATH, { version: 1, models }, { directoryMode: 0o700 });
}

function secretPath(id) {
  return path.join(SECRETS_DIR, `${localId(id)}.key`);
}

function launchPath(id) {
  return path.join(LAUNCH_DIR, `${localId(id)}.json`);
}

function logPath(id) {
  return path.join(LOG_DIR, `${localId(id)}.log`);
}

function providerId(id) {
  return `local-gguf-${localId(id)}`;
}

function readSecret(id) {
  const target = secretPath(id);
  if (!existsSync(target) || !privateFileIsProtected(target)) {
    throw new Error("Local model token is missing or not protected.");
  }
  const value = readFileSync(target, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Local model token is invalid.");
  return value;
}

function ensureSecret(id) {
  const target = secretPath(id);
  if (!existsSync(target)) {
    writePrivateFile(target, `${randomBytes(32).toString("hex")}\n`, { directoryMode: 0o700 });
  }
  return readSecret(id);
}

function readRuntime() {
  if (!existsSync(RUNTIME_PATH)) return { version: 1, active: null };
  try {
    const payload = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
    return payload?.version === 1 ? payload : { version: 1, active: null };
  } catch {
    return { version: 1, active: null };
  }
}

function writeRuntime(active) {
  writePrivateJson(RUNTIME_PATH, { ...readRuntime(), version: 1, active }, { directoryMode: 0o700 });
}

function writeStartup(id, startup) {
  const runtime = readRuntime();
  writePrivateJson(RUNTIME_PATH, {
    ...runtime, startups: { ...runtime.startups, [id]: startup },
  }, { directoryMode: 0o700 });
}

function lookupModel(id) {
  const value = localId(id);
  const model = readLocalGgufRegistry().models.find((entry) => entry.id === value);
  if (!model) throw new Error(`Unknown local GGUF model: ${value}`);
  return model;
}

function safeUnlink(target) {
  try { if (existsSync(target)) unlinkSync(target); } catch { /* best effort cleanup */ }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !processIsAlive(pid);
}

async function terminateExactProcess(active) {
  if (!processIsAlive(active?.pid)) return;
  if (active.processIdentity && processStartIdentity(active.pid) !== active.processIdentity) return;
  try { process.kill(active.pid, "SIGTERM"); } catch { /* already exiting */ }
  if (await waitForProcessExit(active.pid, 5_000)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(active.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
  } else {
    try { process.kill(active.pid, "SIGKILL"); } catch { /* already exited */ }
  }
  await waitForProcessExit(active.pid, 5_000);
}

async function healthFor(active, { timeoutMs = 1_500 } = {}) {
  if (!active?.port || !active?.instanceId) return undefined;
  if (active.runtimeKind === "llama-server") {
    if (!processIsAlive(active.pid) || !active.id || !active.modelId) return undefined;
    let token;
    try { token = readSecret(active.id); } catch { return undefined; }
    try {
      const healthResponse = await fetch(`http://127.0.0.1:${active.port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (healthResponse.status === 503) {
        return { status: "loading", instanceId: active.instanceId };
      }
      if (!healthResponse.ok) return undefined;
      const modelsResponse = await fetch(`http://127.0.0.1:${active.port}/v1/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!modelsResponse.ok) return undefined;
      const payload = await modelsResponse.json();
      const exactModel = Array.isArray(payload?.data)
        && payload.data.some((entry) => entry?.id === active.modelId);
      return exactModel ? {
        status: "ready",
        instanceId: active.instanceId,
        vision: Boolean(active.vision),
        thinking: Boolean(active.thinking),
      } : undefined;
    } catch {
      return processIsAlive(active.pid)
        ? { status: "loading", instanceId: active.instanceId }
        : undefined;
    }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${active.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return payload?.instanceId === active.instanceId ? payload : undefined;
  } catch {
    return undefined;
  }
}

function publishedConnection(id) {
  try {
    return connectionsSnapshot().connections.find((entry) => entry.id === providerId(id));
  } catch {
    return undefined;
  }
}

export async function localGgufRuntimeStatus() {
  const active = readRuntime().active;
  const health = await healthFor(active);
  return health ? { id: active.id, status: health.status === "ready" ? "running" : health.status } : null;
}

export async function localGgufSnapshot() {
  const registry = readLocalGgufRegistry();
  const runtime = readRuntime();
  const health = await healthFor(runtime.active);
  return {
    version: 1,
    security: {
      binding: "127.0.0.1",
      canonicalHistory: "codex-local",
      uploads: false,
      note: "Model files and prompts stay on this device. Publishing only adds a loopback route.",
    },
    active: health ? {
      id: runtime.active.id,
      status: health.status === "ready" ? "running" : health.status,
      startedAt: runtime.active.startedAt,
    } : null,
    models: registry.models.map((model) => {
      let sizeBytes = 0;
      let available = false;
      try {
        const stat = statSync(model.modelPath);
        sizeBytes = stat.isFile() ? stat.size : 0;
        available = stat.isFile()
          && (Boolean(model.serverPath && existsSync(model.serverPath))
            || (existsSync(model.pythonPath)
              && existsSync(path.join(model.dependenciesPath, "llama_cpp", "__init__.py"))));
      } catch { /* a removable drive may currently be unavailable */ }
      const published = publishedConnection(model.id);
      return {
        ...model,
        sizeBytes,
        available,
        status: health && runtime.active?.id === model.id
          ? (health.status === "ready" ? "running" : health.status)
          : "stopped",
        startup: runtime.startups?.[model.id] || null,
        published: Boolean(published?.models.some((entry) => entry.id === model.modelId)),
      };
    }),
  };
}

function candidateFromActionStudio(root) {
  const state = path.join(root, ".action-studio");
  const configPath = path.join(state, "config.json");
  if (!existsSync(configPath) || statSync(configPath).size > 1024 * 1024) return undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const modelPath = path.resolve(String(config.llmRoot || ""), String(config.llmModel || ""));
    const base = path.basename(modelPath, ".gguf");
    const isQwen38ZeroRefusal = /qwen3[._-]?8/i.test(base) && /zero.?refusal/i.test(base);
    const configuredMmproj = typeof config.mmproj === "string" && config.mmproj.trim() && config.mmproj !== "无"
      ? path.resolve(String(config.llmRoot || ""), config.mmproj)
      : null;
    const officialMmproj = path.resolve(String(config.llmRoot || ""), "mmproj-Qwen3.8-27B-F16.gguf");
    const mmprojPath = isQwen38ZeroRefusal && existsSync(officialMmproj)
      ? officialMmproj
      : configuredMmproj;
    const pythonPath = path.resolve(String(config.python || ""));
    const dependenciesPath = path.join(state, "dependencies");
    const serverPath = existsSync(DEFAULT_LLAMA_SERVER) ? realpathSync(DEFAULT_LLAMA_SERVER) : null;
    if (
      path.extname(modelPath).toLowerCase() !== ".gguf"
      || !existsSync(modelPath)
      || (mmprojPath && (!existsSync(mmprojPath) || path.extname(mmprojPath).toLowerCase() !== ".gguf"))
      || !existsSync(pythonPath)
      || !existsSync(path.join(dependenciesPath, "llama_cpp", "__init__.py"))
    ) return undefined;
    const fallbackModelId = base.toLowerCase().replace(/[^a-z0-9._+-]+/g, "-").slice(0, 120);
    return {
      id: base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64),
      displayName: isQwen38ZeroRefusal ? "Qwen3.8 27B ZeroRefusal VL · 本地独立版" : base,
      modelId: isQwen38ZeroRefusal ? "qwen3.8-27b-zerorefusal-vl-local" : fallbackModelId,
      modelPath: realpathSync(modelPath),
      pythonPath: realpathSync(pythonPath),
      dependenciesPath: realpathSync(dependenciesPath),
      mmprojPath: mmprojPath ? realpathSync(mmprojPath) : null,
      serverPath,
      runtimeKind: serverPath ? "llama-server" : "python-llama-cpp",
      inputModalities: mmprojPath ? ["text", "image"] : ["text"],
      thinkingEnabled: isQwen38ZeroRefusal,
      reasoningEffort: "xhigh",
      reasoningLevels: isQwen38ZeroRefusal ? ["low", "medium", "xhigh"] : [],
      sizeBytes: statSync(modelPath).size,
      gpuLayers: 24,
      contextWindow: isQwen38ZeroRefusal ? 262144 : 4096,
      maxOutputTokens: 1024,
      temperature: isQwen38ZeroRefusal ? 1 : 0.6,
      topP: isQwen38ZeroRefusal ? 0.95 : 0.9,
      topK: 20,
      minP: 0,
      repeatPenalty: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stopSequences: ["</s>"],
      port: 4268,
      tuningPreset: isQwen38ZeroRefusal ? "qwen38-zerorefusal-vl-codex" : "generic-gguf-text",
      runnable: true,
      source: "action-studio",
    };
  } catch {
    return undefined;
  }
}

export function discoverLocalGgufModels(rootValue) {
  const root = existingDirectory(rootValue, "Search folder");
  const found = [];
  const exact = candidateFromActionStudio(root);
  if (exact) found.push(exact);
  const known = new Set(found.map((entry) => entry.modelPath.toLowerCase()));
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_DISCOVERY_DIRECTORIES && found.length < MAX_DISCOVERY_RESULTS) {
    const { directory, depth } = queue.shift();
    visited += 1;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 6) {
        if (!["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information"].includes(entry.name)) {
          queue.push({ directory: target, depth: depth + 1 });
        }
      } else if (
        entry.isFile()
        && entry.name.toLowerCase().endsWith(".gguf")
        && !entry.name.toLowerCase().includes("mmproj")
      ) {
        let resolved;
        try { resolved = realpathSync(target); } catch { continue; }
        if (known.has(resolved.toLowerCase())) continue;
        known.add(resolved.toLowerCase());
        found.push({
          id: path.basename(resolved, ".gguf").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64),
          displayName: path.basename(resolved, ".gguf"),
          modelId: path.basename(resolved, ".gguf").toLowerCase().replace(/[^a-z0-9._+-]+/g, "-").slice(0, 120),
          modelPath: resolved,
          sizeBytes: statSync(resolved).size,
          runnable: false,
          missing: ["Python runtime with llama-cpp-python"],
          source: "gguf-scan",
        });
      }
      if (found.length >= MAX_DISCOVERY_RESULTS) break;
    }
  }
  return { root, candidates: found, truncated: queue.length > 0 };
}

export async function addLocalGgufModel(input) {
  const model = validateModel(input);
  const registry = readLocalGgufRegistry();
  if (registry.models.some((entry) => entry.id === model.id)) {
    throw new Error(`Local model ${model.id} already exists.`);
  }
  ensureSecret(model.id);
  writeRegistry([...registry.models, model]);
  return localGgufSnapshot();
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHealth(active, timeoutMs = 300_000, { signal, canStart = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!canStart()) throw new Error("Local model connection was closed during startup.");
    if (!processIsAlive(active.pid) || readRuntime().active?.instanceId !== active.instanceId) {
      throw new Error("Local model runtime stopped during startup.");
    }
    const health = await healthFor(active, { timeoutMs: 1_500 });
    if (health?.status === "ready") return health;
    if (health?.status === "error") throw new Error("Local model runtime could not load this GGUF.");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Local model did not become ready before the timeout.");
}

export async function startLocalGgufModel(id, options = {}) {
  const value = localId(id);
  lookupModel(value);
  options.signal?.throwIfAborted();
  if (options.canStart && !options.canStart()) throw new Error("Local model connection is not active.");
  const startup = { state: "starting", startedAt: new Date().toISOString() };
  writeStartup(value, startup);
  try {
    await startLocalGgufModelImpl(value, options);
    writeStartup(value, { ...startup, state: "succeeded", finishedAt: new Date().toISOString() });
    return localGgufSnapshot();
  } catch (error) {
    writeStartup(value, {
      ...startup,
      state: /timeout|timed out/i.test(error?.message || "") ? "timeout" : "failed",
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function startLocalGgufModelImpl(id, {
  timeoutMs = 300_000, signal, replaceActive = true, canStart = () => true,
} = {}) {
  signal?.throwIfAborted();
  if (!canStart()) throw new Error("Local model connection is not active.");
  const model = validateModel(lookupModel(id));
  const current = readRuntime().active;
  if (current?.id === model.id) {
    const health = await healthFor(current);
    if (health?.status === "ready") return localGgufSnapshot();
    if (health?.status === "loading") {
      await waitForHealth(current, timeoutMs, { signal, canStart });
      return localGgufSnapshot();
    }
  }
  if (current) {
    if (!replaceActive && current.id !== model.id && processIsAlive(current.pid)) {
      throw new Error("Another local model is already running.");
    }
    await stopLocalGgufModel(current.id);
  }
  if (!(await portIsFree(model.port))) {
    const identity = identifyRegisteredLlama(model);
    if (identity) {
      const recovered = {
        ...identity, id: model.id, port: model.port, modelId: model.modelId,
        instanceId: randomUUID(), runtimeKind: "llama-server",
        vision: Boolean(model.mmprojPath), thinking: model.thinkingEnabled,
        startedAt: new Date().toISOString(), recovered: true,
      };
      const health = await healthFor(recovered);
      if (health?.status === "ready") {
        signal?.throwIfAborted();
        if (!canStart()) throw new Error("Local model connection is not active.");
        writeRuntime(recovered);
        return localGgufSnapshot();
      }
    }
    throw new Error(`Local model port ${model.port} is already in use.`);
  }
  signal?.throwIfAborted();
  if (!canStart()) throw new Error("Local model connection is not active.");
  const token = readSecret(model.id);
  const active = {
    id: model.id,
    pid: null,
    port: model.port,
    instanceId: randomUUID(),
    modelId: model.modelId,
    runtimeKind: model.serverPath ? "llama-server" : "python-llama-cpp",
    vision: Boolean(model.mmprojPath),
    thinking: model.thinkingEnabled,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const descriptor = openSync(logPath(model.id), "a", 0o600);
  let child;
  try {
    let executable = model.pythonPath;
    let args = [SERVER, "--config", launchPath(model.id)];
    let cwd = SOURCE_ROOT;
    let childEnv = process.env;
    if (model.serverPath) {
      executable = model.serverPath;
      cwd = path.dirname(model.serverPath);
      args = [
        "--model", model.modelPath,
        "--alias", model.modelId,
        "--host", "127.0.0.1",
        "--port", String(model.port),
        "--ctx-size", String(model.contextWindow),
        "--n-gpu-layers", String(model.gpuLayers),
        "--batch-size", "512",
        "--ubatch-size", "64",
        "--parallel", "1",
        "--flash-attn", "auto",
        "--fit", "off",
        "--offline",
        "--load-mode", "mmap",
        "--jinja",
        "--no-webui",
        "--reasoning", "auto",
        "--reasoning-format", "deepseek",
      ];
      if (model.contextWindow > 32_768) {
        args.push(
          "--cache-type-k", "q8_0",
          "--cache-type-v", "q8_0",
          // Keep reusable system/tool-prefix checkpoints in system RAM. Eight
          // GiB is enough for several long Qwen prefixes on the target 64 GiB
          // machine without starving Windows or forcing the model into swap.
          "--cache-prompt",
          "--cache-ram", "8192",
        );
        // llama.cpp disables shifted/chunk cache reuse when a multimodal
        // projector is loaded. Exact-prefix prompt caching still works (and is
        // the useful case for Codex's repeated system/tool prefix), so request
        // the extra reuse mode only for text-only GGUFs and keep vision intact.
        if (!model.mmprojPath) args.push("--cache-reuse", "256");
      }
      if (model.mmprojPath) {
        args.push(
          "--mmproj", model.mmprojPath,
          "--no-mmproj-offload",
          "--image-max-tokens", "4096",
          "--mtmd-batch-max-tokens", "1024",
        );
      }
      childEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (/^LLAMA_ARG_/i.test(key)) delete childEnv[key];
      }
      childEnv.LLAMA_API_KEY = token;
      safeUnlink(launchPath(model.id));
    } else {
      const launch = { ...model, token, instanceId: active.instanceId };
      writePrivateJson(launchPath(model.id), launch, { directoryMode: 0o700 });
    }
    child = spawn(executable, args, {
      cwd,
      detached: true,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
  child.unref();
  active.pid = child.pid;
  active.processIdentity = processStartIdentity(child.pid);
  writeRuntime(active);
  try {
    await waitForHealth(active, timeoutMs, { signal, canStart });
  } catch (error) {
    if (readRuntime().active?.instanceId === active.instanceId) {
      await terminateExactProcess(active);
      writeRuntime(null);
      safeUnlink(launchPath(model.id));
    }
    throw error;
  }
  return localGgufSnapshot();
}

export async function stopLocalGgufModel(id) {
  const value = localId(id);
  const active = readRuntime().active;
  if (!active || active.id !== value) return localGgufSnapshot();
  const health = await healthFor(active);
  if (active.runtimeKind === "llama-server") {
    await terminateExactProcess(active);
  } else if (health) {
    const token = readSecret(value);
    try {
      await fetch(`http://127.0.0.1:${active.port}/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
    } catch { /* the server may close the socket while retiring */ }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && await healthFor(active, { timeoutMs: 500 })) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (processIsAlive(active.pid)) await terminateExactProcess(active);
  } else if (processIsAlive(active.pid)) {
    await terminateExactProcess(active);
  }
  writeRuntime(null);
  safeUnlink(launchPath(value));
  return localGgufSnapshot();
}

export async function stopAllLocalGgufModels() {
  const active = readRuntime().active;
  if (active?.id) await stopLocalGgufModel(active.id);
  return { stopped: true };
}

export async function testLocalGgufModel(id) {
  const startedAt = Date.now();
  const value = localId(id);
  const previous = readRuntime().active;
  const previousHealth = previous ? await healthFor(previous) : undefined;
  await startLocalGgufModel(value);
  try {
  const model = lookupModel(value);
  const token = readSecret(model.id);
  const response = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        { role: "system", content: "请按用户要求回答，不添加解释。" },
        { role: "user", content: "仅输出中文四个字：测试通过" },
      ],
      max_tokens: 128,
      temperature: model.temperature,
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Local inference test failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
  }
  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || "").trim();
  if (!text.includes("测试通过")) throw new Error("Local model returned an unexpected test response.");
  const contextResponse = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        { role: "system", content: "请读取本次请求携带的完整历史，并严格按最后一条要求回答。" },
        { role: "user", content: "当前项目校验词是：星桥731。" },
        { role: "assistant", content: "已记录当前项目校验词。" },
        { role: "user", content: "仅输出此前的项目校验词，不添加解释。" },
      ],
      max_tokens: 160,
      temperature: 0,
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!contextResponse.ok) {
    const detail = await contextResponse.text();
    throw new Error(`Local context test failed (HTTP ${contextResponse.status}): ${detail.slice(0, 500)}`);
  }
  const contextPayload = await contextResponse.json();
  const contextText = String(contextPayload?.choices?.[0]?.message?.content || "").trim();
  if (!contextText.replace(/\s+/g, "").includes("星桥731")) {
    throw new Error("Local model did not read the earlier conversation context.");
  }
  let reasoning = false;
  if (model.thinkingEnabled) {
    for (const effort of ["medium", "xhigh"]) {
      const reasoningResponse = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: "user", content: "计算 3+4，仅输出答案。" }],
          max_tokens: 512,
          temperature: model.temperature,
          top_p: model.topP,
          top_k: model.topK,
          reasoning_effort: effort,
        }),
        signal: AbortSignal.timeout(180_000),
        redirect: "error",
      });
      if (!reasoningResponse.ok) {
        const detail = await reasoningResponse.text();
        throw new Error(`Local ${effort} reasoning test failed (HTTP ${reasoningResponse.status}): ${detail.slice(0, 500)}`);
      }
      const reasoningPayload = await reasoningResponse.json();
      const reasoningMessage = reasoningPayload?.choices?.[0]?.message;
      if (!String(reasoningMessage?.content || "").trim()) {
        throw new Error(`Local model returned no final answer at ${effort} reasoning effort.`);
      }
    }
    reasoning = true;
  }
  const toolResponse = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.modelId,
      messages: [{ role: "user", content: "读取当前 Codex 上下文。" }],
      tools: [{
        type: "function",
        function: {
          name: "read_codex_context",
          description: "Read canonical context from the current Codex task.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
      tool_choice: { type: "function", function: { name: "read_codex_context" } },
      max_tokens: 256,
      temperature: 0,
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!toolResponse.ok) {
    const detail = await toolResponse.text();
    throw new Error(`Local tool-call test failed (HTTP ${toolResponse.status}): ${detail.slice(0, 500)}`);
  }
  const toolPayload = await toolResponse.json();
  const toolName = toolPayload?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name;
  if (toolName !== "read_codex_context") {
    throw new Error("Local model did not return the required tool call.");
  }
  let vision = false;
  if (model.mmprojPath) {
    const redPng = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACHSURBVHhe7dAhAQAADITA719681QAcQbJbjuzMdg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsGMNg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsGMNg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsGMNg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsHQ4jh0hEeUY0AAAAASUVORK5CYII=";
    const visionResponse = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "这张纯色图片是什么颜色？仅输出两个汉字。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${redPng}` } },
          ],
        }],
        max_tokens: 256,
        temperature: 0,
        reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(180_000),
      redirect: "error",
    });
    if (!visionResponse.ok) {
      const detail = await visionResponse.text();
      throw new Error(`Local vision test failed (HTTP ${visionResponse.status}): ${detail.slice(0, 500)}`);
    }
    const visionPayload = await visionResponse.json();
    const visionText = String(visionPayload?.choices?.[0]?.message?.content || "").trim();
    if (!visionText.includes("红")) throw new Error("Local model did not read the test image.");
    vision = true;
  }
  return {
    ok: true,
    model: model.id,
    text: "测试通过",
    elapsedMs: Date.now() - startedAt,
    binding: "127.0.0.1",
    contextContinuity: true,
    reasoning,
    vision,
    toolCall: true,
  };
  } finally {
    if (previousHealth?.status === "ready" && previous?.id === value) {
      // Preserve a model that was already serving before the diagnostic.
    } else {
      await stopLocalGgufModel(value);
      if (previousHealth?.status === "ready" && previous?.id) {
        await startLocalGgufModel(previous.id);
      }
    }
  }
}

export async function setLocalGgufPublished(id, published) {
  const model = lookupModel(id);
  const connectionId = providerId(model.id);
  const existing = connectionsSnapshot().connections.find((entry) => entry.id === connectionId);
  if (!published) {
    if (existing) await deleteConnection(connectionId);
    return localGgufSnapshot();
  }
  await startLocalGgufModel(model.id);
  const input = {
    name: `本地 · ${model.displayName}`,
    baseUrl: `http://127.0.0.1:${model.port}/v1`,
    adapter: "openai-chat",
    allowPrivate: true,
  };
  if (!existing) {
    await addConnection({
      id: connectionId,
      ...input,
      apiKey: readSecret(model.id),
      models: [model.modelId],
      contextWindow: model.contextWindow,
      modelProfile: {
        displayName: model.displayName,
        requestProfile: "qwen38-local",
        metadata: {
          description: "User-owned Qwen3.8 ZeroRefusal GGUF running locally with native vision and selectable reasoning effort.",
          inputModalities: model.inputModalities,
          reasoningLevels: model.reasoningLevels.map((effort) => ({ effort, description: `${effort} reasoning` })),
          defaultEffort: model.reasoningEffort,
        },
      },
    });
  } else {
    await updateConnection(connectionId, input);
    await setConnectionCredential(connectionId, readSecret(model.id));
    // Refresh the existing catalog row as well as adding a missing one. Local
    // runtime upgrades (context size, modalities, request profile) must reach a
    // model the operator already published; requiring delete/re-add would lose
    // its stable picker identity and make an upgrade look like a new model.
    await addConnectionModels(connectionId, [model.modelId], {
      replaceExisting: true,
      contextWindow: model.contextWindow,
      modelProfile: {
        displayName: model.displayName,
        requestProfile: "qwen38-local",
        metadata: {
          description: "User-owned Qwen3.8 ZeroRefusal GGUF running locally with native vision and selectable reasoning effort.",
          inputModalities: model.inputModalities,
          reasoningLevels: model.reasoningLevels.map((effort) => ({ effort, description: `${effort} reasoning` })),
          defaultEffort: model.reasoningEffort,
        },
      },
    });
    await setConnectionEnabled(connectionId, true);
  }
  return localGgufSnapshot();
}

export async function removeLocalGgufModel(id) {
  const model = lookupModel(id);
  await stopLocalGgufModel(model.id);
  if (publishedConnection(model.id)) await deleteConnection(providerId(model.id));
  writeRegistry(readLocalGgufRegistry().models.filter((entry) => entry.id !== model.id));
  safeUnlink(secretPath(model.id));
  safeUnlink(launchPath(model.id));
  safeUnlink(logPath(model.id));
  return localGgufSnapshot();
}

async function readJsonStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REGISTRY_BYTES) throw new Error("Local model input is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Local model input must be valid JSON."); }
}

async function main(args = process.argv.slice(2)) {
  const action = args[0] || "list";
  let result;
  if (action === "list") result = await localGgufSnapshot();
  else if (action === "discover") result = discoverLocalGgufModels(cleanText(args[1], "Search folder", 4_096));
  else if (action === "add") result = await addLocalGgufModel(await readJsonStdin());
  else if (action === "start") result = await startLocalGgufModel(args[1]);
  else if (action === "stop") result = await stopLocalGgufModel(args[1]);
  else if (action === "stop-all") result = await stopAllLocalGgufModels();
  else if (action === "test") result = await testLocalGgufModel(args[1]);
  else if (action === "publish" || action === "unpublish") {
    result = await setLocalGgufPublished(args[1], action === "publish");
  } else if (action === "remove") result = await removeLocalGgufModel(args[1]);
  else throw new Error("Usage: local-gguf list|discover FOLDER|add|start ID|stop ID|stop-all|test ID|publish ID|unpublish ID|remove ID");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
