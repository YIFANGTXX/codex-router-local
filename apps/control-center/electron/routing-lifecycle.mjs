function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error || "routing activation failed");
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 240);
}

function controlHealthIsReady(result) {
  try {
    return JSON.parse(result?.stdout || "{}").ok === true;
  } catch {
    return false;
  }
}

/**
 * Serializes the Control Center's explicit ownership of the Codex integration.
 *
 * Codex loads model_catalog_json at process startup. The window therefore owns
 * only the configuration for the *next* Codex launch: the user must explicitly
 * connect before we publish the merged catalog, and disconnecting restores
 * Codex's native configuration. The router never touches Codex's task/session
 * history.
 */
export function createRoutingLifecycle({ runControl, runScript, onChange = () => {} } = {}) {
  if (typeof runControl !== "function" || typeof runScript !== "function") {
    throw new TypeError("runControl and runScript are required.");
  }

  let desiredConnected = false;
  let state = "unknown";
  let connected = false;
  let error;
  let generation = 0;
  let worker;
  let healthCheck;
  let phase;

  const snapshot = () => Object.freeze({
    state,
    connected,
    desiredConnected,
    restartRequired: state === "connected" || state === "native",
    ...(phase ? { phase } : {}),
    ...(error ? { error } : {}),
  });

  const publish = () => onChange(snapshot());
  const setState = (next, nextConnected = connected, nextError) => {
    state = next;
    connected = nextConnected;
    error = nextError;
    publish();
  };

  async function connect() {
    setState("connecting", false);
    try {
      phase = "正在启动并检查 Router 后台";
      publish();
      // A router launched by the user's ordinary Startup shortcut can be
      // healthy even when Windows Task Scheduler is unavailable. Check the
      // endpoint first so a restricted/missing scheduled task cannot block the
      // hot-switch window. Only ask the service manager to start it when the
      // direct health probe says it is actually down.
      let routerReady = false;
      try {
        routerReady = controlHealthIsReady(
          await runControl(["health"], { timeoutMs: 15_000 }),
        );
      } catch {
        // A failed probe falls through to the normal service start path.
      }
      if (!routerReady) {
        await runControl(["service", "start"], { timeoutMs: 300_000 });
      }

      // Capture the current native catalog while Codex is still in native
      // mode. This is the step that prevents an old merged-models.json from
      // freezing later OpenAI model-catalog updates.
      await runScript("refresh-catalog.mjs", [], { timeoutMs: 180_000 });

      // Mount the local route only after the native capture succeeded, then
      // rebuild once more so the mounted catalog contains the user's routes.
      await runScript("config-manager.mjs", ["enable"], { timeoutMs: 120_000 });
      await runScript("catalog.mjs", [], { timeoutMs: 120_000 });
      phase = "正在复核后台和 Codex 路由配置";
      publish();
      await verifyConnection();
      phase = undefined;
      setState("connected", true);
    } catch (cause) {
      // A failed activation must leave the next Codex launch native. The
      // rollback is deliberately best-effort only in its reporting; failure is
      // still surfaced and the detached watchdog gets another chance on exit.
      try {
        await runScript("config-manager.mjs", ["disable"], { timeoutMs: 120_000 });
      } catch {
        // Preserve the activation failure, which is the actionable diagnosis.
      }
      phase = undefined;
      setState("error", false, cleanError(cause));
    }
  }

  async function disconnect() {
    phase = undefined;
    setState("disconnecting", connected);
    try {
      // A local GGUF runtime can reserve most of the GPU. Its lifetime follows
      // the visible Control Center window, so hiding or closing the window
      // releases it before the native Codex catalog is restored.
      await runScript("local-gguf.mjs", ["stop-all"], { timeoutMs: 30_000 });
      await runScript("config-manager.mjs", ["disable"], { timeoutMs: 120_000 });
      setState("native", false);
    } catch (cause) {
      setState("error", connected, cleanError(cause));
    }
  }

  async function verifyConnection() {
    const [health, config] = await Promise.all([
      runControl(["health"], { timeoutMs: 15_000 }),
      runScript("config-manager.mjs", ["status"], { timeoutMs: 15_000 }),
    ]);
    if (!controlHealthIsReady(health)) throw new Error("Router 后台没有就绪，请点击连接重试。");
    let mounted = false;
    try { mounted = JSON.parse(config?.stdout || "{}").mode === "router"; } catch {}
    if (!mounted) throw new Error("Codex 路由配置尚未挂载，不能使用中转模型。请重新连接。");
  }

  async function reconcile() {
    while (true) {
      const observedGeneration = generation;
      if (desiredConnected) await connect();
      else await disconnect();
      if (observedGeneration === generation) return snapshot();
    }
  }

  function request(shouldConnect) {
    const nextDesired = shouldConnect === true;
    if (desiredConnected !== nextDesired) {
      desiredConnected = nextDesired;
      generation += 1;
    }
    publish();
    if (!worker && desiredConnected && state === "recovering" && healthCheck) return healthCheck;
    if (
      !worker
      && ((desiredConnected && state === "connected") || (!desiredConnected && state === "native"))
    ) return Promise.resolve(snapshot());
    if (!worker) {
      worker = reconcile().finally(() => { worker = undefined; });
    }
    return worker;
  }

  function ensureHealthy() {
    if (state !== "connected" || !connected || !desiredConnected || worker) {
      return Promise.resolve(snapshot());
    }
    if (healthCheck) return healthCheck;
    healthCheck = (async () => {
      try {
        await verifyConnection();
        return snapshot();
      } catch (cause) {
        if (!desiredConnected) return snapshot();
        // One slow health probe must not rewrite a live task's provider back
        // to OpenAI. Recover the existing local service first, without touching
        // the catalog or model process. Explicit disconnect still wins.
        phase = "后台连接中断，正在恢复；请暂勿发送新消息";
        setState("recovering", false, cleanError(cause));
        try {
          await runControl(["service", "start"], { timeoutMs: 300_000 });
          if (!desiredConnected) return snapshot();
          await verifyConnection();
          if (!desiredConnected) return snapshot();
          phase = undefined;
          setState("connected", true);
        } catch (error) {
          if (!desiredConnected) return snapshot();
          await request(false);
          phase = undefined;
          setState("error", false, `后台恢复失败，已切回原生配置。${cleanError(error)}`);
        }
        return snapshot();
      }
    })().finally(() => { healthCheck = undefined; });
    return healthCheck;
  }

  return Object.freeze({
    request,
    ensureHealthy,
    snapshot,
    hasActiveMutation: () => Boolean(worker || healthCheck),
    whenIdle: () => Promise.all([worker, healthCheck]).then(snapshot),
  });
}
