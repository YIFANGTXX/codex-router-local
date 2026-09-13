import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleOff,
  Cpu,
  FolderSearch,
  GripVertical,
  HardDrive,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import type {
  LocalGgufCandidate,
  LocalGgufDiscovery,
  LocalGgufSnapshot,
  RouterControlApi,
  RoutingStatus,
} from "./types";

type Notice = { tone: "ok" | "error" | "info"; text: string };
type ScanPanelState = { x: number; y: number; collapsed: boolean };

const SCAN_PANEL_STORAGE_KEY = "codex-router.local-scan-panel.v1";

function readScanPanelState(): ScanPanelState {
  try {
    const value = JSON.parse(localStorage.getItem(SCAN_PANEL_STORAGE_KEY) || "null");
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return {
        x: Math.max(-2_000, Math.min(2_000, value.x)),
        y: Math.max(-2_000, Math.min(2_000, value.y)),
        collapsed: value.collapsed === true,
      };
    }
  } catch {
    // Corrupt or unavailable renderer storage falls back to the normal layout.
  }
  return { x: 0, y: 0, collapsed: false };
}

function errorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : String(error || "操作失败");
  return value
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "")
    .split(/\r?\n/)[0]
    .slice(0, 500);
}

function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export default function LocalGgufPage({ api, routing }: { api: RouterControlApi; routing?: RoutingStatus }) {
  const [snapshot, setSnapshot] = useState<LocalGgufSnapshot>();
  const [discovery, setDiscovery] = useState<LocalGgufDiscovery>();
  const [searchRoot, setSearchRoot] = useState("");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [now, setNow] = useState(Date.now());
  const [startedAt, setStartedAt] = useState<number>();
  const [scanPanel, setScanPanel] = useState<ScanPanelState>(readScanPanelState);
  const scanPanelRef = useRef<HTMLElement>(null);
  const scanDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    baseLeft: number;
    baseTop: number;
    width: number;
    height: number;
  } | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.getLocalGgufModels());
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SCAN_PANEL_STORAGE_KEY, JSON.stringify(scanPanel)); } catch { /* UI preference only. */ }
  }, [scanPanel]);

  const keepScanPanelVisible = useCallback(() => {
    const element = scanPanelRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setScanPanel((current) => {
      const x = current.x + (rect.left < 8 ? 8 - rect.left : rect.right > window.innerWidth - 8 ? window.innerWidth - 8 - rect.right : 0);
      const y = current.y + (rect.top < 8 ? 8 - rect.top : rect.bottom > window.innerHeight - 8 ? window.innerHeight - 8 - rect.bottom : 0);
      return x === current.x && y === current.y ? current : { ...current, x, y };
    });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(keepScanPanelVisible);
    window.addEventListener("resize", keepScanPanelVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepScanPanelVisible);
    };
  }, [keepScanPanelVisible, scanPanel.collapsed]);

  const beginScanDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const panel = scanPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    scanDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: scanPanel.x,
      originY: scanPanel.y,
      baseLeft: rect.left - scanPanel.x,
      baseTop: rect.top - scanPanel.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveScanPanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = scanDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const proposedX = drag.originX + event.clientX - drag.startX;
    const proposedY = drag.originY + event.clientY - drag.startY;
    const x = Math.min(window.innerWidth - 8 - drag.baseLeft - drag.width, Math.max(8 - drag.baseLeft, proposedX));
    const y = Math.min(window.innerHeight - 8 - drag.baseTop - drag.height, Math.max(8 - drag.baseTop, proposedY));
    setScanPanel((current) => ({ ...current, x, y }));
  };

  const endScanDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scanDragRef.current?.pointerId !== event.pointerId) return;
    scanDragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const run = async <T,>(key: string, action: () => Promise<T>, success: string) => {
    setBusy(key);
    setStartedAt(Date.now());
    setNotice(undefined);
    try {
      const result = await action();
      if (result && typeof result === "object" && "models" in result) {
        setSnapshot(result as unknown as LocalGgufSnapshot);
        if (key.startsWith("start:") && !(result as unknown as LocalGgufSnapshot).models.some((model) => model.id === key.slice(6) && model.status === "running")) {
          throw new Error("启动尚未成功：后台未确认模型就绪，请查看模型状态。");
        }
      }
      setNotice({ tone: "ok", text: success });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: key.startsWith("start:") && /timeout|timed out/i.test(errorMessage(error))
        ? "启动超时：模型没有在 5 分钟内就绪。请检查模型文件和可用内存后重试。"
        : errorMessage(error) });
      return undefined;
    } finally {
      setBusy(undefined);
      setStartedAt(undefined);
    }
  };

  const discover = async () => {
    setBusy("discover");
    setNotice(undefined);
    try {
      const result = await api.discoverLocalGgufModels(searchRoot);
      setDiscovery(result);
      setNotice({
        tone: "ok",
        text: result.candidates.length
          ? `扫描完成：找到 ${result.candidates.length} 个 GGUF 模型。`
          : "扫描完成：没有找到可用的 GGUF 模型。",
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const registeredPaths = new Set(snapshot?.models.map((model) => model.modelPath.toLowerCase()) || []);

  return (
    <div className="local-page">
      <div className="switch-heading">
        <div>
          <h1>本地模型</h1>
          <p>选择你电脑里已有的 GGUF。这里不会下载模型，也不会把模型、提示词或代码上传到网络。</p>
        </div>
        <button className="switch-icon-button" aria-label="刷新本地模型" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={16} /></button>
      </div>

      <section className="local-safety" role="note">
        <HardDrive size={22} />
        <div><strong>只在本机运行</strong><span>服务只监听 127.0.0.1，并使用随机本机密钥。Codex 仍是唯一聊天历史；Router 只在请求时做格式转换。ZeroRefusal 独立预设会加载千问自己的 mmproj 以保留视觉，但不会加载 MiniMax、H3 或视频提示词。</span></div>
      </section>

      {notice ? <div className={`switch-notice ${notice.tone}`} role="status" aria-live="polite">{notice.tone === "ok" ? <Check size={15} /> : notice.tone === "error" ? <CircleOff size={15} /> : <Activity size={15} />}<span>{notice.text}</span></div> : null}

      <div className="local-workspace">
        <section className="local-models" aria-labelledby="local-models-title">
          <div className="switch-section-title">
            <div><h2 id="local-models-title">已登记的本地模型</h2><p>登记不等于启动；同一时间只运行一个模型，避免占满显存。</p></div>
            <span>{snapshot?.models.length || 0} 个</span>
          </div>
          {!snapshot ? (
            <div className="switch-loading"><LoaderCircle className="spin" size={18} />正在读取本地模型…</div>
          ) : snapshot.models.length === 0 ? (
            <div className="switch-empty"><Cpu size={28} /><h3>还没有登记本地模型</h3><p>在右侧输入模型所在的大文件夹并扫描，然后选择“加入本地模型”。</p></div>
          ) : (
            <div className="local-model-list">
              {snapshot.models.map((model) => {
                const running = model.status === "running";
                const loading = model.status === "loading" || busy === `start:${model.id}`;
                const startup = model.startup;
                const elapsed = Math.max(0, Math.floor((now - (busy === `start:${model.id}` ? startedAt || now : Date.parse(startup?.startedAt || ""))) / 1000));
                const startupTimeout = !running && (startup?.state === "timeout" || (startup?.state === "starting" && elapsed >= 300));
                const modelBusy = busy?.endsWith(model.id);
                return (
                  <article className={`local-model-card ${running ? "running" : loading ? "loading" : ""}`} key={model.id}>
                    <div className="local-model-head">
                      <span className={`local-state ${running ? "on" : ""}`}>{running ? <CheckCircle2 size={16} /> : <HardDrive size={16} />}</span>
                      <div><strong>{model.displayName}</strong><small>{model.modelId}</small></div>
                      <b>{!model.available ? "文件不可用" : running ? "启动成功 · 运行中" : startupTimeout ? "启动超时" : loading ? "启动中" : model.status === "error" || startup?.state === "failed" ? "启动失败" : "已停止"}</b>
                    </div>
                    <div className={`local-runtime-result ${running ? "ok" : startupTimeout || startup?.state === "failed" ? "error" : "info"}`} role="status" aria-live="polite">
                      <strong>{running ? "启动成功" : startupTimeout ? "启动超时" : loading ? "正在启动本地模型" : startup?.state === "failed" ? "上次启动失败" : "本地模型未运行"}</strong>
                      <span>{running ? "本机推理服务已就绪。此状态会持续保留，切换页面不会丢失。"
                        : startupTimeout ? "已超过 5 分钟仍未就绪，请检查内存和模型文件后重试。"
                        : loading ? `已等待 ${Number.isFinite(elapsed) ? elapsed : 0} 秒；最多等待 5 分钟。切换页面不会取消启动。`
                        : startup?.state === "succeeded" ? "上次启动成功，目前服务已停止。再次选择模型发送消息或点击启动即可加载。"
                        : "启动或运行失败只影响本地服务，不代表模型已连接到 Codex。"}</span>
                      <small>{routing?.connected ? "Router 已连接；若 Codex 仍提示 ChatGPT account 不支持，请由你重开 Codex 读取已挂载的配置。" : "Router 尚未连接：请先点击页面上方“连接中转模型”，再在 Codex 中使用此模型。"}</small>
                    </div>
                    <div className="local-model-facts">
                      <span>{fileSize(model.sizeBytes)}</span><span>GPU {model.gpuLayers} 层</span><span>{model.contextWindow.toLocaleString()} 上下文</span><span>{model.inputModalities.includes("image") ? "原生视觉" : "纯文本"}</span><span>{model.thinkingEnabled ? `思考 ${model.reasoningLevels.join("/")} · 默认 ${model.reasoningEffort}` : "不思考"}</span><span>{model.runtimeKind === "llama-server" ? "官方 llama.cpp 视觉运行时" : "Python 兼容运行时"}</span><span>{model.tuningPreset === "qwen38-zerorefusal-vl-codex" ? "ZeroRefusal 独立预设" : model.tuningPreset}</span><span>端口 {model.port}</span>
                    </div>
                    <p title={model.modelPath}>{model.modelPath}</p>
                    {model.published ? (
                      <div className="local-published"><Radio size={14} /><span><strong>已保存到模型目录</strong> · 不代表当前 Codex 任务已接通；聊天记录仍由 Codex 本地保存。</span></div>
                    ) : null}
                    <div className="local-actions">
                      <button disabled={!model.available || running || Boolean(busy)} onClick={() => void run(`start:${model.id}`, () => api.startLocalGgufModel(model.id), "启动成功：本地模型已就绪，只监听 127.0.0.1；Codex 是否接入请查看上方 Router 状态。")}>{busy === `start:${model.id}` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}启动</button>
                      <button disabled={!model.available || Boolean(modelBusy)} onClick={() => void run(`test:${model.id}`, async () => {
                        const result = await api.testLocalGgufModel(model.id);
                        await refresh();
                        return result;
                      }, "本地能力测试通过；此测试直连模型，不代表当前 Codex 任务已接通。测试前的运行状态已恢复。")}>{busy === `test:${model.id}` ? <LoaderCircle className="spin" size={14} /> : <Activity size={14} />}测试能力</button>
                      <button disabled={!running || Boolean(modelBusy)} onClick={() => void run(`stop:${model.id}`, () => api.stopLocalGgufModel(model.id), "本地模型已停止，显存已释放。")}>{busy === `stop:${model.id}` ? <LoaderCircle className="spin" size={14} /> : <Square size={13} />}停止</button>
                      <button className={model.published ? "published" : "primary"} disabled={(!model.available && !model.published) || Boolean(modelBusy)} onClick={() => void run(`publish:${model.id}`, () => api.setLocalGgufPublished(model.id, !model.published), model.published ? "已从 Codex 模型目录移除；本地模型文件没有删除。" : "发布成功：本地模型已加入 Codex。首次发布后重开一次 Codex 刷新模型菜单。")}>{busy === `publish:${model.id}` ? <LoaderCircle className="spin" size={14} /> : <Radio size={14} />}{model.published ? "从 Codex 移除" : "发布到 Codex"}</button>
                      <button className="danger" disabled={Boolean(modelBusy)} onClick={() => void run(`remove:${model.id}`, () => api.removeLocalGgufModel(model.id), "本地登记已删除；GGUF 模型文件仍保留在原位置。")}>{busy === `remove:${model.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}删除登记</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside
          ref={scanPanelRef}
          className={`local-import ${scanPanel.collapsed ? "is-collapsed" : ""}`}
          aria-labelledby="local-import-title"
          style={{ transform: `translate3d(${scanPanel.x}px, ${scanPanel.y}px, 0)` }}
        >
          <div
            className="local-import-head"
            title="拖动面板；双击恢复原位"
            onPointerDown={beginScanDrag}
            onPointerMove={moveScanPanel}
            onPointerUp={endScanDrag}
            onPointerCancel={endScanDrag}
            onDoubleClick={() => setScanPanel((current) => ({ ...current, x: 0, y: 0 }))}
          >
            <GripVertical aria-hidden size={17} />
            <h2 id="local-import-title">扫描已有模型</h2>
            <button
              type="button"
              className="local-import-collapse"
              aria-label={scanPanel.collapsed ? "展开扫描面板" : "收纳扫描面板"}
              aria-expanded={!scanPanel.collapsed}
              onClick={() => setScanPanel((current) => ({ ...current, collapsed: !current.collapsed }))}
            >
              {scanPanel.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
          {!scanPanel.collapsed ? <div className="local-import-body">
            <p>输入一个本机文件夹。只读取文件名、大小和本地运行配置，不打开模型内容。</p>
            <label><span>模型所在文件夹</span><input value={searchRoot} placeholder="例如：C:\\Models" onChange={(event) => setSearchRoot(event.target.value)} /></label>
            <button className="switch-primary local-scan" disabled={!searchRoot.trim() || Boolean(busy)} onClick={() => void discover()}>{busy === "discover" ? <LoaderCircle className="spin" size={15} /> : <FolderSearch size={15} />}{busy === "discover" ? "正在扫描…" : "扫描本地模型"}</button>
            {discovery ? (
              <div className="local-candidates">
                {discovery.candidates.map((candidate) => {
                  const registered = registeredPaths.has(candidate.modelPath.toLowerCase());
                  return <CandidateCard key={candidate.modelPath} candidate={candidate} registered={registered} busy={busy === `add:${candidate.id}`} onAdd={() => void run(`add:${candidate.id}`, () => api.addLocalGgufModel(candidate), "添加成功：本地模型已登记，但尚未启动或发布。")}/>;
                })}
                {discovery.candidates.length === 0 ? <p className="local-none">没有发现 GGUF 文件。</p> : null}
              </div>
            ) : null}
            <small>“删除登记”只删除这条本地配置，不会删除磁盘上的 GGUF。</small>
          </div> : null}
        </aside>
      </div>
    </div>
  );
}

function CandidateCard({ candidate, registered, busy, onAdd }: {
  candidate: LocalGgufCandidate;
  registered: boolean;
  busy: boolean;
  onAdd(): void;
}) {
  return (
    <article className="local-candidate">
      <div><strong>{candidate.displayName}</strong><span>{fileSize(candidate.sizeBytes)} · {candidate.tuningPreset === "qwen38-zerorefusal-vl-codex" ? "已识别千问视觉与思考调教" : candidate.source === "action-studio" ? "已识别现有运行环境" : "GGUF"}</span></div>
      <p title={candidate.modelPath}>{candidate.modelPath}</p>
      {!candidate.runnable ? <small>缺少：{candidate.missing?.join("、") || "可用的本地运行环境"}</small> : null}
      <button disabled={registered || !candidate.runnable || busy} onClick={onAdd}>{busy ? <LoaderCircle className="spin" size={13} /> : registered ? <Check size={13} /> : <HardDrive size={13} />}{registered ? "已加入" : "加入本地模型"}</button>
    </article>
  );
}
