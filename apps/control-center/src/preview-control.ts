import type {
  ConnectionSnapshot,
  FallbackSnapshot,
  LocalGgufSnapshot,
  RouterControlApi,
  RouterHealth,
} from "./types";

let connections: ConnectionSnapshot = {
  version: 1,
  security: {
    canonicalHistory: "codex-local",
    keys: "protected-local-files",
    externalDefaults: 0,
    note: "Preview data",
  },
  connections: [
    {
      id: "local-lab",
      name: "示例 · 本地推理",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapter: "openai-chat",
      allowPrivate: true,
      enabled: true,
      credential: { required: false, configured: true, source: "user-approved local endpoint (no key)" },
      models: [
        { id: "coder-local", slug: "local-lab/coder-local", name: "Coder Local", contextWindow: 131072 },
      ],
    },
  ],
};

let fallback: FallbackSnapshot = { enabled: false, chain: [] };
let routing = { state: "native", connected: false, desiredConnected: false, restartRequired: true };
let localGguf: LocalGgufSnapshot = {
  version: 1,
  security: { binding: "127.0.0.1", canonicalHistory: "codex-local", uploads: false, note: "Preview data" },
  active: null,
  models: [],
};

export function previewControl(): RouterControlApi {
  const health: RouterHealth = { ok: true, activity: { state: "idle", activeCount: 0, active: [] } };
  return {
    platform: "win32",
    minimizeWindow: async () => undefined,
    toggleMaximizeWindow: async () => undefined,
    closeWindow: async () => undefined,
    getConnections: async () => connections,
    getLocalGgufModels: async () => localGguf,
    discoverLocalGgufModels: async (root: string) => ({ root, candidates: [], truncated: false }),
    addLocalGgufModel: async () => localGguf,
    startLocalGgufModel: async () => localGguf,
    stopLocalGgufModel: async () => localGguf,
    testLocalGgufModel: async () => ({ ok: true, model: "preview", text: "测试通过", elapsedMs: 1200, binding: "127.0.0.1", contextContinuity: true, reasoning: true, vision: true, toolCall: true }),
    setLocalGgufPublished: async () => localGguf,
    removeLocalGgufModel: async () => localGguf,
    getHealth: async () => health,
    getRoutingStatus: async () => routing,
    setRoutingConnected: async (enabled: boolean) => (routing = enabled
      ? { state: "connected", connected: true, desiredConnected: true, restartRequired: true }
      : { state: "native", connected: false, desiredConnected: false, restartRequired: true }),
    getFallback: async () => fallback,
    addConnection: async () => connections,
    updateConnection: async () => connections,
    setConnectionEnabled: async (id: string, enabled: boolean) => {
      connections = { ...connections, connections: connections.connections.map((entry) => entry.id === id ? { ...entry, enabled } : entry) };
      return connections;
    },
    setConnectionCredential: async () => connections,
    clearConnectionCredential: async () => connections,
    addConnectionModel: async () => connections,
    removeConnectionModel: async () => connections,
    testConnection: async () => ({ ok: true, status: 200, endpoint: "local preview", message: "Provider endpoint is reachable." }),
    testConnectionInput: async () => ({ ok: true, reachable: true, status: 200, endpoint: "local preview", elapsedMs: 36, message: "Provider endpoint is reachable." }),
    discoverConnectionModels: async () => ({ provider: "local-lab", discovered: ["coder-local", "coder-fast", "coder-large"], cached: false }),
    removeConnection: async () => connections,
    setFallback: async (enabled: boolean, chain: string[]) => (fallback = { enabled, chain }),
    getProjectRoute: async (project: string) => ({ project, path: `${project}/.codex/config.toml`, managed: false }),
    setProjectRoute: async (project: string, model: string) => ({ project, path: `${project}/.codex/config.toml`, managed: true, model }),
    clearProjectRoute: async (project: string) => ({ project, path: `${project}/.codex/config.toml`, managed: false }),
  } as unknown as RouterControlApi;
}
