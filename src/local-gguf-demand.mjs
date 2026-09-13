import { readFileSync } from "node:fs";
import { lifecycleStatePath, queryLifecycleState } from "../apps/control-center/electron/lifecycle-state.mjs";
import { isManagedCallerBaseUrl } from "./caller-auth.mjs";
import { CONFIG_PATH, PORTS } from "./paths.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";

export class LocalRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalRuntimeError";
    // A local lifecycle failure must not silently fall back to a remote API.
    this.status = 400;
  }
}

export function localDemandAllowed({
  lifecycle = queryLifecycleState(lifecycleStatePath()),
  readConfig = () => readFileSync(CONFIG_PATH, "utf8"),
  now = Date.now(),
} = {}) {
  if (!lifecycle.running || !lifecycle.ready || !lifecycle.visible) return false;
  const age = now - Date.parse(lifecycle.updatedAt || "");
  if (!Number.isFinite(age) || age < 0 || age > 8_000) return false;
  try {
    const document = scanTomlDocument(readConfig());
    return isManagedCallerBaseUrl(tomlStringValue(document, [], "openai_base_url"), PORTS.router);
  } catch { return false; }
}

// Only routes published from the local registry can start an executable. A
// user-entered API with a similar name/profile cannot opt into process launch.
export function managedLocalModel(model, provider, registry) {
  if (provider?.generic !== true || provider.allowPrivate !== true || provider.enabled === false
    || model?.requestProfile !== "qwen38-local") return undefined;
  return registry.models.find((entry) => provider.id === `local-gguf-${entry.id}`
    && model.upstreamModel === entry.modelId
    && provider.baseUrl === `http://127.0.0.1:${entry.port}/v1`);
}

export function createLocalModelDemand({ readRegistry, runtimeStatus, start, allowed = localDemandAllowed }) {
  let pending;
  return async function ensure(model, provider, signal) {
    if (provider?.generic !== true || model?.requestProfile !== "qwen38-local"
      || !provider.id?.startsWith("local-gguf-")) return false;
    let local;
    try { local = managedLocalModel(model, provider, readRegistry()); }
    catch {
      throw new LocalRuntimeError("无法读取本地模型登记信息，请在本地模型页面检查配置。没有转发到外部 API。");
    }
    if (!local) throw new LocalRuntimeError("本地模型路由与登记信息不一致，请在本地模型页面重新发布。");
    signal?.throwIfAborted();
    if (!allowed()) throw new LocalRuntimeError("本地模型未连接。请打开热切换工具，点击“连接中转模型”后重试。");
    if (pending && pending.id !== local.id) {
      throw new LocalRuntimeError("另一个本地模型正在启动，请等它就绪后再切换。");
    }
    if (!pending) {
      const entry = { id: local.id, controller: new AbortController(), users: 0 };
      pending = entry;
      entry.promise = Promise.resolve().then(async () => {
        try {
          const current = await runtimeStatus();
          entry.controller.signal.throwIfAborted();
          if (current && current.id !== local.id) {
            throw new LocalRuntimeError("另一个本地模型正在运行。请先在本地模型页面停止它，再选择此模型。");
          }
          if (!allowed()) throw new LocalRuntimeError("本地模型连接已断开，请重新连接后重试。");
          if (current?.status === "running") return true;
          await start(local.id, {
            signal: entry.controller.signal,
            replaceActive: false,
            canStart: allowed,
          });
          return true;
        } catch (error) {
          if (error instanceof LocalRuntimeError || entry.controller.signal.aborted) throw error;
          // Do not expose runtime stderr, local paths, credentials or prompts.
          throw new LocalRuntimeError("本地模型启动失败，请在本地模型页面查看状态并重试。没有转发到外部 API。");
        } finally {
          if (pending === entry) pending = undefined;
        }
      });
    }
    const entry = pending;
    entry.users += 1;
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal?.addEventListener("abort", abort, { once: true });
        entry.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
        if (signal?.aborted) abort();
      });
    } finally {
      entry.users -= 1;
      if (!entry.users && pending === entry) entry.controller.abort();
    }
  };
}

let ensureDemand;
export async function ensureLocalModelForRequest(model, provider, signal) {
  if (model?.requestProfile !== "qwen38-local" || !provider?.id?.startsWith("local-gguf-")) return;
  // Lazy import keeps the remote/native request path independent of local
  // runtime management and its connection-publication dependencies.
  const local = await import("./local-gguf.mjs");
  ensureDemand ||= createLocalModelDemand({
    readRegistry: local.readLocalGgufRegistry,
    runtimeStatus: local.localGgufRuntimeStatus,
    start: local.startLocalGgufModel,
  });
  return ensureDemand(model, provider, signal);
}
