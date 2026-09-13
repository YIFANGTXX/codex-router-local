import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  EyeOff,
  FolderGit2,
  Globe2,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import type {
  AddConnectionInput,
  ConnectionAdapter,
  ConnectionModelCatalog,
  ConnectionSnapshot,
  FallbackSnapshot,
  RouterHealth,
  RoutingStatus,
  UpdateConnectionInput,
  UserConnection,
} from "./types";
import { previewControl } from "./preview-control";
import LocalGgufPage from "./LocalGgufPage";
import "./hot-switch.css";

type Notice = { tone: "ok" | "error" | "info"; text: string };
type LinkCheck = { tone: "ok" | "warning" | "error"; title: string; detail: string };

const EMPTY_FORM: AddConnectionInput = {
  id: "",
  name: "",
  baseUrl: "",
  adapter: "openai-responses",
  allowPrivate: false,
  apiKey: "",
  models: [],
};

const ADAPTER_COPY: Record<ConnectionAdapter, string> = {
  "openai-responses": "Responses API",
  "openai-chat": "Chat Completions",
  "openai-completions": "OpenAI Completions 兼容",
};

function rawMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "操作失败");
}

function message(error: unknown) {
  const detail = rawMessage(error);
  if (/source root could not be located/i.test(detail)) return "找不到本机 Router 运行目录，请重新启动或修复安装。";
  if (/file:\/\/\//i.test(detail) || /\s+at\s+file:/i.test(detail)) return "本机操作失败，请重试。";
  return detail.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "").split(/\r?\n/)[0].slice(0, 500);
}

function linkErrorMessage(error: unknown) {
  const detail = rawMessage(error);
  if (/did not return JSON|invalid model list/i.test(detail)) return "这个 Base URL 的 /models 没有返回模型列表。请检查供应商文档；很多 OpenAI 兼容地址需要以 /v1 结尾。";
  if (/absolute HTTP\(S\) URL|baseUrl.*invalid/i.test(detail)) return "请输入以 http:// 或 https:// 开头的完整 Base URL。";
  if (/allowPrivate=true|private or loopback|private or link-local/i.test(detail)) return "这是本机或内网地址，请先勾选下方的本机/内网选项。";
  if (/Could not resolve provider host/i.test(detail)) return "无法解析这个地址，请检查域名是否正确。";
  if (/timed?\s*out|abort/i.test(detail)) return "连接超时，请检查地址、网络或本地服务是否正在运行。";
  return detail;
}

function routerState(health?: RouterHealth, routing?: RoutingStatus) {
  if (routing?.state === "connecting" || routing?.state === "recovering") return { tone: "checking", title: routing.state === "recovering" ? "正在恢复后台连接" : "正在连接中转模型", detail: routing.phase || "正在复核后台和路由配置，请稍候" };
  if (routing?.state === "disconnecting") return { tone: "checking", title: "正在恢复原生模型", detail: "不会修改聊天记录" };
  if (routing?.state === "error") return { tone: "offline", title: "中转连接失败", detail: routing.error || "请点击连接重试" };
  if (routing && !routing.connected) return { tone: "native", title: "原生模型模式", detail: "中转目录未挂载" };
  if (!health) return { tone: "checking", title: "正在确认本地路由", detail: "只检查本机，不访问供应商" };
  if (health.ok) {
    return health.activity?.state === "generating"
      ? { tone: "online", title: "热切换运行中", detail: "正在处理当前任务" }
      : { tone: "online", title: "Router 已连接", detail: "Codex 路由配置已挂载" };
  }
  const coreReady = health.router === "ready" || (health.service === "codex-router" && Number(health.status) > 0);
  if (coreReady) return { tone: "degraded", title: "本地路由已启动", detail: "模型转发器正在恢复" };
  return { tone: "offline", title: "本地路由未启动", detail: "点击刷新重新检测" };
}

export default function HotSwitchApp() {
  const api = useMemo(
    () => window.routerControl ?? (import.meta.env.DEV ? previewControl() : undefined),
    [],
  );
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>();
  const [health, setHealth] = useState<RouterHealth>();
  const [routing, setRouting] = useState<RoutingStatus>();
  const [fallback, setFallback] = useState<FallbackSnapshot>({ enabled: false, chain: [] });
  const [savedFallback, setSavedFallback] = useState<FallbackSnapshot>({ enabled: false, chain: [] });
  const [fallbackDraft, setFallbackDraft] = useState<string[]>([]);
  const [form, setForm] = useState<AddConnectionInput>(EMPTY_FORM);
  const [modelText, setModelText] = useState("");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [connectionCatalogs, setConnectionCatalogs] = useState<Record<string, ConnectionModelCatalog>>({});
  const [expanded, setExpanded] = useState<string>();
  const [projectPath, setProjectPath] = useState("");
  const [projectModel, setProjectModel] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const [linkCheck, setLinkCheck] = useState<LinkCheck>();
  const [view, setView] = useState<"connections" | "local">("connections");
  const routingRevision = useRef(0);

  const readRoutingStatus = useCallback(() => (
    typeof api?.getRoutingStatus === "function"
      ? api.getRoutingStatus().catch(() => ({
          state: "error",
          connected: false,
          desiredConnected: true,
          restartRequired: false,
        } as RoutingStatus))
      : Promise.resolve({
          state: "connected",
          connected: true,
          desiredConnected: true,
          restartRequired: false,
        } as RoutingStatus)
  ), [api]);

  const refresh = useCallback(async () => {
    if (!api) return;
    const revision = routingRevision.current;
    setLoadError(undefined);
    try {
      const [connections, nextHealth, nextFallback, nextRouting] = await Promise.all([
        api.getConnections(),
        api.getHealth().catch(() => ({ ok: false } as RouterHealth)),
        api.getFallback(),
        readRoutingStatus(),
      ]);
      setSnapshot(connections);
      if (revision === routingRevision.current) setHealth(nextHealth);
      setFallback(nextFallback);
      setSavedFallback(nextFallback);
      setFallbackDraft(nextFallback.chain || []);
      if (revision === routingRevision.current) setRouting(nextRouting);
    } catch (error) {
      const detail = message(error);
      setLoadError(detail);
      setNotice({ tone: "error", text: detail });
    }
  }, [api, readRoutingStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!api) return undefined;
    const timer = window.setInterval(() => {
      const revision = routingRevision.current;
      void Promise.all([
        api.getHealth().catch(() => ({ ok: false, status: 0 } as RouterHealth)),
        readRoutingStatus(),
      ]).then(([nextHealth, nextRouting]) => {
        if (revision !== routingRevision.current) return;
        setHealth(nextHealth);
        setRouting(nextRouting);
      }).catch(() => setHealth({ ok: false, status: 0 }));
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [api, readRoutingStatus]);

  useEffect(() => {
    setLinkCheck(undefined);
  }, [form.baseUrl, form.adapter, form.allowPrivate, form.apiKey]);

  const run = useCallback(async <T,>(key: string, action: () => Promise<T>, success: string) => {
    setBusy(key);
    setNotice(undefined);
    try {
      const result = await action();
      if (result && typeof result === "object" && "connections" in result) {
        setSnapshot(result as unknown as ConnectionSnapshot);
      }
      setNotice({ tone: "ok", text: success });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: message(error) });
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, []);

  const allModels = useMemo(
    () => snapshot?.connections.flatMap((connection) => connection.models.map((model) => ({
      ...model,
      connection: connection.name,
    }))) || [],
    [snapshot],
  );
  const status = routerState(health, routing);
  const publishedModelCount = allModels.length;
  const readyConnectionCount = snapshot?.connections.filter((connection) =>
    connection.enabled &&
    connection.models.length > 0 &&
    (!connection.credential.required || connection.credential.configured)
  ).length || 0;

  const addConnection = async () => {
    if (!api) return;
    const models = modelText.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    const connectionId = form.id;
    const result = await run(
      "add",
      () => api.addConnection({ ...form, models, apiKey: form.apiKey?.trim() || undefined }),
      models.length
        ? "连接已保存在本机，并发布到 Codex 模型列表。"
        : "连接已保存在本机。展开连接后可读取供应商模型。",
    );
    if (result) {
      setForm(EMPTY_FORM);
      setModelText("");
      setExpanded(connectionId);
    }
  };

  const discoverConnectionModels = async (connectionId: string) => {
    if (!api) return;
    setBusy(`discover:${connectionId}`);
    setNotice(undefined);
    try {
      const catalog = await api.discoverConnectionModels(connectionId);
      setConnectionCatalogs((current) => ({ ...current, [connectionId]: catalog }));
      setNotice({
        tone: "ok",
        text: catalog.discovered.length
          ? `已从该连接读取 ${catalog.discovered.length} 个供应商模型。`
          : "连接正常，但供应商没有返回可选模型。",
      });
    } catch (error) {
      setNotice({ tone: "error", text: `读取供应商模型失败：${linkErrorMessage(error)}` });
    } finally {
      setBusy(undefined);
    }
  };

  const testConnectionInput = async () => {
    if (!api || !form.baseUrl.trim()) return;
    setBusy("link-check");
    setNotice(undefined);
    setLinkCheck(undefined);
    try {
      const result = await api.testConnectionInput({
        baseUrl: form.baseUrl,
        adapter: form.adapter,
        allowPrivate: form.allowPrivate,
        apiKey: form.apiKey?.trim() || undefined,
      });
      const timing = Number.isFinite(result.elapsedMs) ? ` · ${Math.round(result.elapsedMs || 0)} ms` : "";
      if (result.ok) {
        setLinkCheck({ tone: "ok", title: "连接成功", detail: `HTTP ${result.status}${timing}，地址和认证均可用。` });
      } else if ([401, 403].includes(result.status)) {
        setLinkCheck({ tone: "warning", title: "地址可达，但认证未通过", detail: `HTTP ${result.status}${timing}，请检查 API Key。` });
      } else {
        setLinkCheck({ tone: "warning", title: "地址可达，但接口返回异常", detail: `HTTP ${result.status}${timing}，请检查 Base URL 是否包含正确的 API 路径。` });
      }
    } catch (error) {
      setLinkCheck({ tone: "error", title: "无法连接", detail: linkErrorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const setRoutingConnected = async (enabled: boolean) => {
    if (!api) return;
    routingRevision.current++;
    setBusy("routing");
    setNotice(undefined);
    setRouting({ state: enabled ? "connecting" : "disconnecting", connected: false, desiredConnected: enabled, restartRequired: false });
    try {
      const result = await api.setRoutingConnected(enabled);
      const nextHealth = await api.getHealth().catch(() => ({ ok: false, status: 0 } as RouterHealth));
      routingRevision.current++;
      setRouting(result);
      setHealth(nextHealth);
      if (result.state === "error" || (enabled && (!result.connected || !nextHealth.ok))) {
        setNotice({ tone: "error", text: result.error || "连接尚未完成，请根据下方状态重试。" });
      }
    } catch (error) {
      routingRevision.current++;
      setRouting({ state: "error", connected: false, desiredConnected: enabled, restartRequired: false, error: message(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const toggleFallbackModel = (slug: string) => {
    setFallbackDraft((current) => current.includes(slug)
      ? current.filter((entry) => entry !== slug)
      : [...current, slug]);
  };

  if (!api) {
    return <main className="switch-unavailable"><Unplug /><h1>请从桌面版打开</h1><p>本地控制桥未连接。</p></main>;
  }

  return (
    <div className="switch-shell">
      <header className="switch-titlebar">
        <div className="switch-brand"><Zap size={17} /><strong>Codex Router</strong><span>本地热切换</span></div>
        {api.platform !== "darwin" ? (
          <div className="switch-window-actions">
            <button aria-label="最小化" onClick={() => void api.minimizeWindow()}><Minus size={14} /></button>
            <button aria-label="最大化或还原" onClick={() => void api.toggleMaximizeWindow()}><ChevronRight className="switch-maximize" size={14} /></button>
            <button aria-label="关闭" onClick={() => void api.closeWindow()}><X size={14} /></button>
          </div>
        ) : null}
      </header>

      <aside className="switch-trust-rail">
        <div className="switch-status">
          <i className={status.tone} />
          <div><strong>{status.title}</strong><span>{status.detail}</span></div>
        </div>
        <nav className="switch-nav" aria-label="功能页面">
          <button className={view === "connections" ? "active" : ""} onClick={() => setView("connections")}><Globe2 size={16} />API 热切换</button>
          <button className={view === "local" ? "active" : ""} onClick={() => setView("local")}><HardDrive size={16} />本地模型</button>
        </nav>
        <div className="switch-trust-copy">
          <ShieldCheck size={20} />
          <h2>数据边界</h2>
          <p>Codex 本地任务是唯一聊天历史。Router 不建立第二份会话，也不覆盖原记录。</p>
          <ul>
            <li><Check size={13} />无预置联网供应商</li>
            <li><Check size={13} />API Key 仅写入本机受保护文件</li>
            <li><Check size={13} />只在发起请求时转换上下文</li>
          </ul>
        </div>
        <div className="switch-boundary-warning">
          <EyeOff size={16} />
          <p>使用某个外部 API 时，完成任务所需的上下文和工具结果会发送给该 API。只添加你信任的地址。</p>
        </div>
        <div className="switch-steps">
          <h2>如何切换</h2>
          <ol>
            <li><span>1</span>在这里添加自己的 API 和模型。</li>
            <li><span>2</span>保持工具打开，等到“Router 已连接”。最小化不影响连接。</li>
            <li><span>3</span>首次接入或仍报 ChatGPT account 不支持时，由你重开 Codex 读取配置；原任务与聊天记录保留。</li>
          </ol>
        </div>
      </aside>

      <main className="switch-main">
        <section className={`switch-readiness ${routing?.connected && health?.ok ? "ready" : "recovering"}`} role="status" aria-live="polite">
          {routing?.connected && health?.ok ? <CheckCircle2 size={24} /> : <Activity size={22} />}
          <div className="switch-readiness-copy">
            <strong>{status.title}</strong><span>{status.detail}</span>
            <span>{routing?.connected && health?.ok
              ? `已保存 ${publishedModelCount} 个模型，${readyConnectionCount} 个连接可用。这里只确认后台和配置；模型启动成功不等于当前 Codex 任务已接入。`
              : "未接通时请勿在 Codex 中使用中转模型，否则模型名可能仍被发送给 ChatGPT 原生接口。"}</span>
          </div>
          <button className="switch-primary switch-routing-button" disabled={!routing || busy === "routing" || ["connecting", "recovering", "disconnecting"].includes(routing.state)} onClick={() => void setRoutingConnected(!routing?.connected)}>
            {busy === "routing" || ["connecting", "recovering"].includes(routing?.state || "") ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}
            {routing?.connected ? "切回原生模型" : "连接中转模型"}
          </button>
        </section>
        <div hidden={view !== "local"}><LocalGgufPage api={api} routing={routing} /></div>
        <div hidden={view !== "connections"}>
        <div className="switch-heading">
          <div><h1>连接与热切换</h1><p>这里只显示你亲自添加的连接。模型本体不会被下载或预装。</p></div>
          <button className="switch-icon-button" aria-label="刷新" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={16} /></button>
        </div>

        {notice ? <div className={`switch-notice ${notice.tone}`}>{notice.tone === "ok" ? <Check size={15} /> : notice.tone === "error" ? <CircleOff size={15} /> : <Activity size={15} />}<span>{notice.text}</span></div> : null}


        <div className="switch-workspace">
          <section className="switch-connections" aria-labelledby="connections-title">
            <div className="switch-section-title"><h2 id="connections-title">我的连接</h2><span>{snapshot?.connections.length || 0} 个</span></div>
            {!snapshot && loadError ? (
              <div className="switch-empty switch-load-error">
                <CircleOff size={28} />
                <h3>无法读取本地配置</h3>
                <p>读取已经停止，不会一直重试。请确认本机 Router 正在运行，然后重试。</p>
                <button className="switch-secondary" onClick={() => void refresh()}><RefreshCw size={14} />重试读取</button>
              </div>
            ) : !snapshot ? <div className="switch-loading"><LoaderCircle className="spin" size={18} />正在读取本地配置…</div> : snapshot.connections.length === 0 ? (
              <div className="switch-empty"><Unplug size={28} /><h3>还没有外部连接</h3><p>当前没有任何第三方地址可接收你的任务内容。使用右侧表单添加第一个连接。</p></div>
            ) : (
              <div className="switch-connection-list">
                {snapshot.connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    expanded={expanded === connection.id}
                    busy={busy}
                    keyDraft={keyDrafts[connection.id] || ""}
                    modelDraft={modelDrafts[connection.id] || ""}
                    catalog={connectionCatalogs[connection.id]}
                    runtimeReady={health?.ok === true}
                    onExpand={() => setExpanded(expanded === connection.id ? undefined : connection.id)}
                    onKeyDraft={(value) => setKeyDrafts((current) => ({ ...current, [connection.id]: value }))}
                    onModelDraft={(value) => setModelDrafts((current) => ({ ...current, [connection.id]: value }))}
                    onToggle={() => void run(`toggle:${connection.id}`, () => api.setConnectionEnabled(connection.id, !connection.enabled), connection.enabled ? "连接已停用。" : "连接已启用。")}
                    onUpdate={(input) => run(`edit:${connection.id}`, () => api.updateConnection(connection.id, input), "连接地址已更新；没有修改系统网络设置。").then((result) => {
                      if (!result) return false;
                      setConnectionCatalogs((current) => {
                        const next = { ...current };
                        delete next[connection.id];
                        return next;
                      });
                      return true;
                    })}
                    onTest={() => void run(`test:${connection.id}`, async () => {
                      const result = await api.testConnection(connection.id);
                      if (!result.ok) throw new Error(result.message || `健康检查失败（HTTP ${result.status}）。`);
                      return result;
                    }, "健康检查通过。")}
                    onDiscover={() => void discoverConnectionModels(connection.id)}
                    onSaveKey={() => void run(`key:${connection.id}`, () => api.setConnectionCredential(connection.id, keyDrafts[connection.id] || ""), "API Key 已替换；不会显示在界面中。").then((result) => result && setKeyDrafts((current) => ({ ...current, [connection.id]: "" })))}
                    onClearKey={() => void run(`key-clear:${connection.id}`, () => api.clearConnectionCredential(connection.id), "API Key 已从本机删除。")}
                    onAddModel={() => {
                      const modelId = modelDrafts[connection.id] || "";
                      void run(`model:${connection.id}`, () => api.addConnectionModel(connection.id, modelId), `添加成功：${modelId} 已发布到 Codex。首次发布后重开一次 Codex，即可在当前任务的模型菜单选择。`).then(async (result) => {
                        if (!result) return;
                        setModelDrafts((current) => ({ ...current, [connection.id]: "" }));
                        const nextHealth = await api.getHealth().catch(() => undefined);
                        if (nextHealth) setHealth(nextHealth);
                      });
                    }}
                    onRemoveModel={(model) => void run(`model-remove:${model}`, () => api.removeConnectionModel(connection.id, model), "模型已移除。")}
                    onRemove={() => void run(`remove:${connection.id}`, () => api.removeConnection(connection.id), "连接、模型和本机密钥已移除。")}
                  />
                ))}
              </div>
            )}

            <section className="switch-fallback" aria-labelledby="fallback-title">
              <div className="switch-section-title"><div><h2 id="fallback-title">失败接力</h2><p>仅在 429 或服务失败且尚未返回内容时，按顺序尝试你选择的连接。</p></div><label className="switch-toggle"><input type="checkbox" checked={fallback.enabled} onChange={(event) => setFallback((current) => ({ ...current, enabled: event.target.checked }))} /><span /></label></div>
              {allModels.length ? (
                <div className="switch-fallback-models">
                  {allModels.map((model) => {
                    const order = fallbackDraft.indexOf(model.slug);
                    return <button className={order >= 0 ? "selected" : ""} key={model.slug} onClick={() => toggleFallbackModel(model.slug)}><span>{order >= 0 ? order + 1 : <Plus size={13} />}</span><div><strong>{model.name}</strong><small>{model.connection}</small></div>{order >= 0 ? <ArrowDown size={14} /> : null}</button>;
                  })}
                </div>
              ) : <p className="switch-muted">添加模型后才能设置接力顺序。</p>}
              <div className="switch-fallback-actions"><button className="switch-secondary" onClick={() => { setFallback(savedFallback); setFallbackDraft(savedFallback.chain || []); }}><RotateCcw size={14} />恢复</button><button className="switch-primary" disabled={busy === "fallback"} onClick={() => void run("fallback", () => api.setFallback(fallback.enabled, fallbackDraft), "失败接力设置已保存。").then((result) => {
                if (!result) return;
                const next = result as FallbackSnapshot;
                setFallback(next);
                setSavedFallback(next);
                setFallbackDraft(next.chain || []);
              })}>{busy === "fallback" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存接力</button></div>
            </section>

            <section className="switch-project" aria-labelledby="project-title">
              <div className="switch-section-title"><div><h2 id="project-title">可选：项目启动默认模型</h2><p>只决定项目打开时先选哪个模型，不锁定任务；进入任务后仍可随时切换。留空不会影响全局热切换。</p></div><FolderGit2 size={19} /></div>
              <div className="switch-project-fields">
                <label><span>项目文件夹</span><input value={projectPath} placeholder="C:\\Projects\\my-app" onChange={(event) => setProjectPath(event.target.value)} /></label>
                <label><span>默认模型</span><select value={projectModel} onChange={(event) => setProjectModel(event.target.value)}><option value="">选择模型</option>{allModels.map((model) => <option value={model.slug} key={model.slug}>{model.name} · {model.connection}</option>)}</select></label>
              </div>
              <div className="switch-fallback-actions"><button className="switch-secondary" disabled={!projectPath} onClick={() => void run("project-clear", () => api.clearProjectRoute(projectPath), "项目默认路由已清除。")}>清除</button><button className="switch-primary" disabled={!projectPath || !projectModel || busy === "project"} onClick={() => void run("project", () => api.setProjectRoute(projectPath, projectModel), "项目默认模型已保存。")}>{busy === "project" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存项目默认</button></div>
            </section>
          </section>

          <section className="switch-add" aria-labelledby="add-title">
            <h2 id="add-title">添加自己的 API</h2>
            <p>没有模板目录，也不会自动寻找免费端点。所有字段由你提供。</p>
            <label><span>连接名称</span><input value={form.name} placeholder="例如：公司网关" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label><span>本地标识</span><input value={form.id} placeholder="例如：company-api" spellCheck={false} onChange={(event) => setForm({ ...form, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /><small>只用于本机路由名称，不会发送给供应商。</small></label>
            <label><span>Base URL</span><input value={form.baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
            <label><span>API 格式</span><select value={form.adapter} onChange={(event) => setForm({ ...form, adapter: event.target.value as ConnectionAdapter })}>{Object.entries(ADAPTER_COPY).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label><span>手动模型 ID（可选）</span><textarea value={modelText} placeholder={"可以留空；保存连接后读取供应商模型\n或每行填写一个准确模型 ID"} onChange={(event) => setModelText(event.target.value)} /><small>建议留空并使用“读取供应商模型”；仅当 API 不提供 /models 时手动填写。</small></label>
            <label><span>API Key（可选）</span><input type="password" autoComplete="new-password" value={form.apiKey || ""} placeholder="只写入本机受保护文件" onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label>
            <label className="switch-checkbox"><input type="checkbox" checked={form.allowPrivate} onChange={(event) => setForm({ ...form, allowPrivate: event.target.checked })} /><span><strong>这是本机或内网地址</strong><small>仅勾选后允许 HTTP、localhost 或私有 IP。</small></span></label>
            <div className="switch-link-check">
              <button className="switch-secondary" disabled={Boolean(busy) || !form.baseUrl.trim()} onClick={() => void testConnectionInput()}>
                {busy === "link-check" ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}
                {busy === "link-check" ? "正在检测…" : "检测链接"}
              </button>
              <small>访问 Base URL 的 /models；只检测一次，不保存表单或 API Key。</small>
            </div>
            {linkCheck ? (
              <div className={`switch-link-result ${linkCheck.tone}`} role="status" aria-live="polite">
                {linkCheck.tone === "ok" ? <Check size={16} /> : linkCheck.tone === "warning" ? <Activity size={16} /> : <CircleOff size={16} />}
                <div><strong>{linkCheck.title}</strong><span>{linkCheck.detail}</span></div>
              </div>
            ) : null}
            <button className="switch-primary switch-add-button" disabled={Boolean(busy) || !form.id || !form.name || !form.baseUrl} onClick={() => void addConnection()}>{busy === "add" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{modelText.trim() ? "保存并发布" : "保存连接"}</button>
          </section>
        </div>
        </div>
      </main>
    </div>
  );
}

function ConnectionRow({
  connection,
  expanded,
  busy,
  keyDraft,
  modelDraft,
  catalog,
  runtimeReady,
  onExpand,
  onKeyDraft,
  onModelDraft,
  onToggle,
  onUpdate,
  onTest,
  onDiscover,
  onSaveKey,
  onClearKey,
  onAddModel,
  onRemoveModel,
  onRemove,
}: {
  connection: UserConnection;
  expanded: boolean;
  busy?: string;
  keyDraft: string;
  modelDraft: string;
  catalog?: ConnectionModelCatalog;
  runtimeReady: boolean;
  onExpand(): void;
  onKeyDraft(value: string): void;
  onModelDraft(value: string): void;
  onToggle(): void;
  onUpdate(input: UpdateConnectionInput): Promise<boolean>;
  onTest(): void;
  onDiscover(): void;
  onSaveKey(): void;
  onClearKey(): void;
  onAddModel(): void;
  onRemoveModel(model: string): void;
  onRemove(): void;
}) {
  const isBusy = busy?.endsWith(connection.id) || busy?.includes(connection.id);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(connection.name);
  const [editBaseUrl, setEditBaseUrl] = useState(connection.baseUrl);
  const [editAdapter, setEditAdapter] = useState<ConnectionAdapter>(connection.adapter);
  const [editAllowPrivate, setEditAllowPrivate] = useState(connection.allowPrivate);
  const publishedModels = new Set(connection.models.map((model) => model.id));
  const availableModels = (catalog?.discovered || []).filter((model) => !publishedModels.has(model));
  const connectionReady = connection.enabled && connection.models.length > 0 && (!connection.credential.required || connection.credential.configured);
  const cancelEdit = () => {
    setEditName(connection.name);
    setEditBaseUrl(connection.baseUrl);
    setEditAdapter(connection.adapter);
    setEditAllowPrivate(connection.allowPrivate);
    setEditing(false);
  };
  return (
    <article className={`switch-connection ${expanded ? "expanded" : ""}`}>
      <button className="switch-connection-summary" aria-expanded={expanded} onClick={onExpand}>
        <span className={`switch-connection-light ${connection.enabled ? "on" : "off"}`} />
        <div className="switch-connection-name"><strong>{connection.name}</strong><small>{connection.baseUrl}</small></div>
        <div className="switch-connection-facts">{connectionReady ? <span className="success"><CheckCircle2 size={12} />已添加</span> : null}<span>{ADAPTER_COPY[connection.adapter]}</span><span>{connection.models.length} 个模型</span><span>{connection.credential.required ? (connection.credential.configured ? "密钥已保护" : "缺少密钥") : "无需密钥"}</span></div>
        <ChevronRight size={16} />
      </button>
      {expanded ? (
        <div className="switch-connection-detail">
          {connectionReady ? (
            <div className={`switch-publish-proof ${runtimeReady ? "ready" : "recovering"}`}>
              {runtimeReady ? <CheckCircle2 size={19} /> : <RefreshCw size={18} />}
              <div><strong>{runtimeReady ? "已添加到 Codex · 可以热切换" : "已经添加，正在载入本地转发器"}</strong><span>{runtimeReady ? "从当前任务的模型菜单选择即可，原聊天记录继续使用。" : "完成后状态会自动变绿，不需要再次添加。"}</span></div>
            </div>
          ) : null}
          {editing ? (
            <div className="switch-connection-editor">
              <label><span>连接名称</span><input value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
              <label><span>Base URL</span><input value={editBaseUrl} spellCheck={false} onChange={(event) => setEditBaseUrl(event.target.value)} /></label>
              <label><span>API 格式</span><select value={editAdapter} onChange={(event) => setEditAdapter(event.target.value as ConnectionAdapter)}>{Object.entries(ADAPTER_COPY).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <label className="switch-checkbox"><input type="checkbox" checked={editAllowPrivate} onChange={(event) => setEditAllowPrivate(event.target.checked)} /><span><strong>这是本机或内网地址</strong><small>公网 HTTPS 地址通常不需要勾选。</small></span></label>
              <p>只更新 Router 中这条连接，不会修改系统代理、DNS、网卡或 Codex 聊天记录。</p>
              <div className="switch-editor-actions"><button onClick={cancelEdit}>取消</button><button className="switch-primary" disabled={!editName.trim() || !editBaseUrl.trim() || Boolean(isBusy)} onClick={() => void onUpdate({ name: editName, baseUrl: editBaseUrl, adapter: editAdapter, allowPrivate: editAllowPrivate }).then((saved) => saved && setEditing(false))}>{busy === `edit:${connection.id}` ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存地址</button></div>
            </div>
          ) : null}
          <div className="switch-model-list">
            {connection.models.map((model) => <div key={model.slug}><span><strong>{model.name}</strong><small>{model.slug}</small></span><button aria-label={`移除 ${model.name}`} onClick={() => onRemoveModel(model.id)}><Trash2 size={13} /></button></div>)}
          </div>
          <div className="switch-provider-discovery">
            <div><strong>供应商模型</strong><small>只有点击读取时才访问这个连接的 /models；不会修改系统网络。</small></div>
            <button onClick={onDiscover} disabled={Boolean(isBusy)}>{busy === `discover:${connection.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{catalog ? "重新读取" : "读取模型"}</button>
          </div>
          {catalog ? (
            <div className="switch-inline-form switch-catalog-picker">
              <select aria-label={`${connection.name} 的供应商模型`} value={availableModels.includes(modelDraft) ? modelDraft : ""} onChange={(event) => onModelDraft(event.target.value)}>
                <option value="">{availableModels.length ? `选择供应商返回的模型（${availableModels.length}）` : "返回的模型均已添加"}</option>
                {availableModels.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
              <button disabled={!availableModels.includes(modelDraft) || Boolean(isBusy)} onClick={onAddModel}><Plus size={14} />添加到 Codex</button>
            </div>
          ) : null}
          <div className="switch-inline-form switch-manual-model"><input value={availableModels.includes(modelDraft) ? "" : modelDraft} placeholder="手动输入准确模型 ID（备用）" onChange={(event) => onModelDraft(event.target.value)} /><button disabled={!modelDraft.trim() || availableModels.includes(modelDraft) || Boolean(isBusy)} onClick={onAddModel}><Plus size={14} />手动添加</button></div>
          <div className="switch-inline-form"><input type="password" autoComplete="new-password" value={keyDraft} placeholder="替换或添加 API Key" onChange={(event) => onKeyDraft(event.target.value)} /><button disabled={!keyDraft.trim() || Boolean(isBusy)} onClick={onSaveKey}><KeyRound size={14} />保存</button>{connection.credential.required ? <button className="danger" onClick={onClearKey}><Trash2 size={14} />删除密钥</button> : null}</div>
          <div className="switch-row-actions"><button onClick={() => setEditing((current) => !current)} disabled={Boolean(isBusy)}><Pencil size={14} />编辑地址</button><button onClick={onTest} disabled={Boolean(isBusy)}><Activity size={14} />检查连接</button><button onClick={onToggle} disabled={Boolean(isBusy)}>{connection.enabled ? <CircleOff size={14} /> : <Zap size={14} />}{connection.enabled ? "停用" : "启用"}</button><button className="danger" onClick={onRemove} disabled={Boolean(isBusy)}><Trash2 size={14} />删除连接</button></div>
        </div>
      ) : null}
    </article>
  );
}
