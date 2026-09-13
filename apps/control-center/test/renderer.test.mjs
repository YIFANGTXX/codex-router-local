import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

const bridgeSource = String.raw`
(() => {
  const calls = [];
  let connections = {
    version: 1,
    security: {
      canonicalHistory: "codex-local",
      keys: "protected-local-files",
      externalDefaults: 0,
      note: "Only user-created connections are listed.",
    },
    connections: [{
      id: "local-lab",
      name: "Local Lab",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapter: "openai-chat",
      allowPrivate: true,
      enabled: true,
      credential: { required: false, configured: true, source: "local endpoint" },
      models: [{ id: "coder-local", slug: "local-lab/coder-local", name: "Coder Local", contextWindow: 131072 }],
    }],
  };
  let fallback = { enabled: false, chain: [] };
  let localGguf = {
    version: 1,
    security: { binding: "127.0.0.1", canonicalHistory: "codex-local", uploads: false, note: "local only" },
    active: null,
    models: [{
      id: "qwen-local",
      displayName: "Qwen3.8 27B ZeroRefusal VL · 本地独立版",
      modelId: "qwen3.8-27b-zerorefusal-vl-local",
      modelPath: "C:\\\\Models\\\\qwen.gguf",
      pythonPath: "C:\\\\Runtime\\\\python.exe",
      dependenciesPath: "C:\\\\Runtime\\\\dependencies",
      mmprojPath: "C:\\\\Models\\\\qwen-mmproj.gguf",
      serverPath: "C:\\\\router\\\\llama-server.exe",
      runtimeKind: "llama-server",
      inputModalities: ["text", "image"],
      thinkingEnabled: true,
      reasoningEffort: "xhigh",
      reasoningLevels: ["low", "medium", "xhigh"],
      sizeBytes: 14252845056,
      gpuLayers: 24,
      contextWindow: 262144,
      maxOutputTokens: 1024,
      temperature: 1,
      topP: 0.95,
      topK: 20,
      minP: 0,
      repeatPenalty: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stopSequences: ["</s>"],
      port: 4268,
      tuningPreset: "qwen38-zerorefusal-vl-codex",
      createdAt: "2026-09-12T00:00:00.000Z",
      available: true,
      status: "stopped",
      published: false,
    }],
  };
  const record = (name, ...args) => calls.push({ name, args });
  let routing = {
    state: "connected",
    connected: true,
    desiredConnected: true,
    restartRequired: true,
  };

  window.routerControl = Object.freeze({
    platform: "linux",
    getConnections: async () => {
      if (new URLSearchParams(location.search).has("failLoad")) {
        throw new Error("fixture connection failure");
      }
      return connections;
    },
    getLocalGgufModels: async () => localGguf,
    discoverLocalGgufModels: async (root) => {
      record("discoverLocalGgufModels", root);
      return { root, candidates: [], truncated: false };
    },
    addLocalGgufModel: async (input) => { record("addLocalGgufModel", input.id); return localGguf; },
    startLocalGgufModel: async (id) => {
      record("startLocalGgufModel", id);
      const startedAt = new Date().toISOString();
      if (new URLSearchParams(location.search).has("startTimeout")) {
        localGguf.models[0].startup = { state: "timeout", startedAt, finishedAt: startedAt };
        throw new Error("Router command timed out.");
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      localGguf = { ...localGguf, active: { id, status: "running", startedAt }, models: localGguf.models.map((model) => model.id === id ? { ...model, status: "running", startup: { state: "succeeded", startedAt, finishedAt: new Date().toISOString() } } : model) };
      return localGguf;
    },
    stopLocalGgufModel: async (id) => { record("stopLocalGgufModel", id); return localGguf; },
    testLocalGgufModel: async (id) => {
      record("testLocalGgufModel", id);
      localGguf = { ...localGguf, active: { id, status: "running", startedAt: new Date().toISOString() }, models: localGguf.models.map((model) => model.id === id ? { ...model, status: "running" } : model) };
      return { ok: true, model: id, text: "测试通过", elapsedMs: 15330, binding: "127.0.0.1", contextContinuity: true, reasoning: true, vision: true, toolCall: true };
    },
    setLocalGgufPublished: async (id, published) => {
      record("setLocalGgufPublished", id, published);
      localGguf = { ...localGguf, models: localGguf.models.map((model) => model.id === id ? { ...model, published } : model) };
      return localGguf;
    },
    removeLocalGgufModel: async (id) => { record("removeLocalGgufModel", id); return localGguf; },
    getHealth: async () => ({ ok: true, activity: { state: "idle", active: [], activeCount: 0 } }),
    getRoutingStatus: async () => routing,
    setRoutingConnected: async (enabled) => {
      record("setRoutingConnected", enabled);
      routing = enabled
        ? { state: "connected", connected: true, desiredConnected: true, restartRequired: true }
        : { state: "native", connected: false, desiredConnected: false, restartRequired: true };
      if (enabled && new URLSearchParams(location.search).has("failConnect")) routing = { state: "error", connected: false, desiredConnected: true, restartRequired: false, error: "测试：后台启动失败" };
      return routing;
    },
    getFallback: async () => fallback,
    addConnection: async (input) => {
      record("addConnection", { ...input, apiKey: input.apiKey ? "[received]" : undefined });
      connections = {
        ...connections,
        connections: [...connections.connections, {
          id: input.id,
          name: input.name,
          baseUrl: input.baseUrl,
          adapter: input.adapter,
          allowPrivate: input.allowPrivate,
          enabled: true,
          credential: { required: Boolean(input.apiKey), configured: Boolean(input.apiKey), source: "protected local file" },
          models: input.models.map((id) => ({ id, slug: input.id + "/" + id, name: id, contextWindow: 128000 })),
        }],
      };
      return connections;
    },
    updateConnection: async (id, input) => {
      record("updateConnection", id, input);
      connections = {
        ...connections,
        connections: connections.connections.map((item) => item.id === id ? { ...item, ...input } : item),
      };
      return connections;
    },
    setConnectionEnabled: async (id, enabled) => {
      record("setConnectionEnabled", id, enabled);
      connections = { ...connections, connections: connections.connections.map((item) => item.id === id ? { ...item, enabled } : item) };
      return connections;
    },
    setConnectionCredential: async (id) => { record("setConnectionCredential", id); return connections; },
    clearConnectionCredential: async (id) => { record("clearConnectionCredential", id); return connections; },
    addConnectionModel: async (id, model) => {
      record("addConnectionModel", id, model);
      connections = {
        ...connections,
        connections: connections.connections.map((item) => item.id === id
          ? { ...item, models: [...item.models, { id: model, slug: id + "/" + model, name: model, contextWindow: 128000 }] }
          : item),
      };
      return connections;
    },
    removeConnectionModel: async (id, model) => { record("removeConnectionModel", id, model); return connections; },
    testConnection: async (id) => { record("testConnection", id); return { ok: true, status: 200, endpoint: "local", message: "reachable" }; },
    testConnectionInput: async (input) => {
      record("testConnectionInput", { ...input, apiKey: input.apiKey ? "[received]" : undefined });
      return { ok: true, reachable: true, status: 200, endpoint: input.baseUrl + "/models", elapsedMs: 42, message: "reachable" };
    },
    discoverConnectionModels: async (id) => {
      record("discoverConnectionModels", id);
      return { provider: id, discovered: ["coder-local", "coder-fast", "coder-large"], cached: false };
    },
    removeConnection: async (id) => { record("removeConnection", id); return connections; },
    setFallback: async (enabled, chain) => {
      record("setFallback", enabled, [...chain]);
      fallback = { enabled, chain: [...chain] };
      return fallback;
    },
    getProjectRoute: async (project) => ({ project, path: project + "/.codex/config.toml", managed: false }),
    setProjectRoute: async (project, model) => { record("setProjectRoute", project, model); return { project, model, managed: true }; },
    clearProjectRoute: async (project) => { record("clearProjectRoute", project); return { project, managed: false }; },
  });
  window.routerControlTest = Object.freeze({ calls: () => calls.map((call) => ({ name: call.name, args: call.args })) });
})();
`;

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/test-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if ((target !== dist && !target.startsWith(`${dist}${path.sep}`)) || !existsSync(target)) {
      response.writeHead(404).end("not found");
      return;
    }
    let contents = readFileSync(target);
    if (relative === "index.html") {
      const html = contents.toString("utf8");
      assert.match(html, /<script type="module"/);
      contents = Buffer.from(
        html.replace('<script type="module"', '<script src="./test-bridge.js"></script><script type="module"'),
      );
    }
    response.writeHead(200, { "content-type": mimeType(target) });
    response.end(contents);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

test("the production renderer is a user-owned hot-switch shell", { timeout: 60_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "连接与热切换", exact: true }).waitFor();
    assert.match(await page.locator(".switch-trust-rail").innerText(), /Codex 本地任务是唯一聊天历史/);
    assert.match(await page.locator(".switch-trust-rail").innerText(), /无预置联网供应商/);
    assert.match(await page.locator(".switch-heading:visible").innerText(), /模型本体不会被下载或预装/);
    await page.locator(".switch-connection").waitFor();
    assert.equal(await page.locator(".switch-connection").count(), 1);

    await page.locator(".switch-connection-summary").click();
    const existingConnection = page.locator(".switch-connection").first();
    await existingConnection.getByRole("button", { name: "编辑地址", exact: true }).click();
    await existingConnection.getByLabel("Base URL").fill("http://127.0.0.1:11434/v1-updated");
    await existingConnection.getByRole("button", { name: "保存地址", exact: true }).click();
    await page.getByText("连接地址已更新；没有修改系统网络设置。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await page.getByText("健康检查通过。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "读取模型", exact: true }).click();
    await page.getByText("已从该连接读取 3 个供应商模型。", { exact: true }).waitFor();
    await page.getByLabel("Local Lab 的供应商模型").selectOption("coder-fast");
    await page.getByRole("button", { name: "添加到 Codex", exact: true }).click();
    await page.getByText("添加成功：coder-fast 已发布到 Codex。首次发布后重开一次 Codex，即可在当前任务的模型菜单选择。", { exact: true }).waitFor();
    await page.locator(".switch-readiness").getByText("Router 已连接", { exact: true }).waitFor();
    await page.getByRole("button", { name: "切回原生模型", exact: true }).click();
    await page.locator(".switch-readiness").getByText("原生模型模式", { exact: true }).waitFor();
    await page.getByRole("button", { name: "连接中转模型", exact: true }).click();
    await page.locator(".switch-readiness").getByText("Router 已连接", { exact: true }).waitFor();

    const add = page.locator(".switch-add");
    await add.getByLabel("连接名称").fill("Company Gateway");
    await add.getByLabel("本地标识").fill("company-api");
    await add.getByLabel("Base URL").fill("https://api.example.test/v1");
    await add.getByLabel("模型 ID").fill("coder-one\ncoder-two");
    await add.getByLabel("API Key（可选）").fill("fixture-secret");
    await add.getByRole("button", { name: "检测链接", exact: true }).click();
    await add.getByText("连接成功", { exact: true }).waitFor();
    assert.match(await add.locator(".switch-link-result").innerText(), /HTTP 200 · 42 ms/);
    await add.getByRole("button", { name: "保存并发布", exact: true }).click();
    await page.getByText("连接已保存在本机，并发布到 Codex 模型列表。", { exact: true }).waitFor();
    assert.equal(await page.locator(".switch-connection").count(), 2);

    const project = page.locator(".switch-project");
    await project.getByLabel("项目文件夹").fill("C:\\Projects\\sample");
    await project.locator("select").selectOption("local-lab/coder-local");
    await page.getByRole("button", { name: "保存项目默认", exact: true }).click();

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(
      calls.filter((call) => call.name === "setRoutingConnected").map((call) => call.args),
      [[false], [true]],
    );
    assert.deepEqual(calls.find((call) => call.name === "testConnection")?.args, ["local-lab"]);
    assert.deepEqual(calls.find((call) => call.name === "updateConnection")?.args, ["local-lab", {
      name: "Local Lab",
      baseUrl: "http://127.0.0.1:11434/v1-updated",
      adapter: "openai-chat",
      allowPrivate: true,
    }]);
    assert.deepEqual(calls.find((call) => call.name === "discoverConnectionModels")?.args, ["local-lab"]);
    assert.deepEqual(calls.find((call) => call.name === "addConnectionModel")?.args, ["local-lab", "coder-fast"]);
    assert.deepEqual(calls.find((call) => call.name === "testConnectionInput")?.args, [{
      baseUrl: "https://api.example.test/v1",
      adapter: "openai-responses",
      allowPrivate: false,
      apiKey: "[received]",
    }]);
    assert.deepEqual(calls.find((call) => call.name === "addConnection")?.args, [{
      id: "company-api",
      name: "Company Gateway",
      baseUrl: "https://api.example.test/v1",
      adapter: "openai-responses",
      allowPrivate: false,
      apiKey: "[received]",
      models: ["coder-one", "coder-two"],
    }]);
    assert.deepEqual(calls.find((call) => call.name === "setProjectRoute")?.args, [
      "C:\\Projects\\sample",
      "local-lab/coder-local",
    ]);

    await page.getByRole("button", { name: "本地模型", exact: true }).click();
    await page.getByRole("heading", { name: "本地模型", exact: true }).waitFor();
    assert.match(await page.locator(".local-safety").innerText(), /只在本机运行/);
    assert.match(await page.locator(".local-model-card").innerText(), /Qwen3\.8 27B ZeroRefusal/);
    assert.match(await page.locator(".local-model-card").innerText(), /ZeroRefusal 独立预设/);
    const scanPanel = page.locator(".local-import");
    const scanHandle = page.locator(".local-import-head");
    const beforeDrag = await scanPanel.boundingBox();
    const handleBox = await scanHandle.boundingBox();
    assert.ok(beforeDrag && handleBox, "scan panel is not visible");
    await page.mouse.move(handleBox.x + 70, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 10, handleBox.y + handleBox.height / 2 + 55, { steps: 5 });
    await page.mouse.up();
    const afterDrag = await scanPanel.boundingBox();
    assert.ok(afterDrag && afterDrag.x < beforeDrag.x - 50 && afterDrag.y > beforeDrag.y + 30, "scan panel did not move");
    await page.getByRole("button", { name: "收纳扫描面板", exact: true }).click();
    assert.equal(await scanPanel.getByLabel("模型所在文件夹").count(), 0);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("codex-router.local-scan-panel.v1")))).collapsed, true);
    await page.getByRole("button", { name: "展开扫描面板", exact: true }).click();
    await scanHandle.dblclick({ position: { x: 70, y: 16 } });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("codex-router.local-scan-panel.v1")).x === 0);
    await page.getByRole("button", { name: "测试能力", exact: true }).click();
    await page.getByText("本地能力测试通过；此测试直连模型，不代表当前 Codex 任务已接通。测试前的运行状态已恢复。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "发布到 Codex", exact: true }).click();
    await page.getByText("发布成功：本地模型已加入 Codex。首次发布后重开一次 Codex 刷新模型菜单。", { exact: true }).waitFor();
    const publicShots = path.resolve(appRoot, "../../generated/public-release");
    mkdirSync(publicShots, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(publicShots, "control-center.png"), fullPage: true });
    const localCalls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(localCalls.find((call) => call.name === "testLocalGgufModel")?.args, ["qwen-local"]);
    assert.deepEqual(localCalls.find((call) => call.name === "setLocalGgufPublished")?.args, ["qwen-local", true]);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);

    const failedErrors = [];
    const failedPage = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    failedPage.on("pageerror", (error) => failedErrors.push(error.message));
    failedPage.on("console", (message) => {
      if (message.type() === "error") failedErrors.push(message.text());
    });
    await failedPage.goto(`${url}?failLoad=1`, { waitUntil: "domcontentloaded" });
    await failedPage.getByRole("heading", { name: "无法读取本地配置", exact: true }).waitFor();
    assert.equal(await failedPage.getByText("正在读取本地配置…", { exact: true }).count(), 0);
    assert.equal(await failedPage.getByRole("button", { name: "重试读取", exact: true }).count(), 1);
    assert.deepEqual(failedErrors, [], `failed-load renderer errors: ${failedErrors.join("; ")}`);
    await failedPage.close();

    const operationPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await operationPage.goto(`${url}?failConnect=1`, { waitUntil: "domcontentloaded" });
    await operationPage.getByRole("button", { name: "切回原生模型", exact: true }).click();
    await operationPage.getByRole("button", { name: "连接中转模型", exact: true }).click();
    await operationPage.locator(".switch-readiness").getByText("中转连接失败", { exact: true }).waitFor();
    assert.match(await operationPage.locator(".switch-status").innerText(), /中转连接失败/);
    assert.equal(await operationPage.locator(".switch-notice.ok:visible").count(), 0, "a resolved failure must never show success");
    await operationPage.getByRole("button", { name: "本地模型", exact: true }).click();
    await operationPage.getByRole("button", { name: "启动", exact: true }).click();
    await operationPage.getByRole("button", { name: "API 热切换", exact: true }).click();
    await operationPage.getByRole("button", { name: "本地模型", exact: true }).click();
    await operationPage.locator(".local-runtime-result").getByText("启动成功", { exact: true }).waitFor();
    await operationPage.getByRole("button", { name: "API 热切换", exact: true }).click();
    await operationPage.getByRole("button", { name: "本地模型", exact: true }).click();
    assert.match(await operationPage.locator(".local-runtime-result").innerText(), /启动成功/);
    const shots = path.resolve(appRoot, "../../generated/status-verification");
    mkdirSync(shots, { recursive: true });
    await operationPage.screenshot({ path: path.join(shots, "desktop.png"), fullPage: true });
    await operationPage.setViewportSize({ width: 700, height: 900 });
    await operationPage.screenshot({ path: path.join(shots, "compact.png"), fullPage: true });
    assert.equal(await operationPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await operationPage.close();

    const timeoutPage = await browser.newPage();
    await timeoutPage.goto(`${url}?startTimeout=1`, { waitUntil: "domcontentloaded" });
    await timeoutPage.getByRole("button", { name: "本地模型", exact: true }).click();
    await timeoutPage.getByRole("button", { name: "启动", exact: true }).click();
    await timeoutPage.getByText(/启动超时：模型没有在/).waitFor();
    await timeoutPage.getByRole("button", { name: "API 热切换", exact: true }).click();
    await timeoutPage.getByRole("button", { name: "本地模型", exact: true }).click();
    await timeoutPage.getByRole("button", { name: "刷新本地模型", exact: true }).click();
    await timeoutPage.locator(".local-runtime-result").getByText("启动超时", { exact: true }).waitFor();
    assert.equal(await timeoutPage.locator(".local-runtime-result").getByText("启动成功", { exact: true }).count(), 0);
    await timeoutPage.close();
  } finally {
    await browser.close();
    await close();
  }
});
