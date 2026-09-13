import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("local GGUF discovery reuses an existing Action Studio runtime without publishing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-local-gguf-"));
  const state = path.join(root, "state");
  const actionState = path.join(root, ".action-studio");
  const dependencies = path.join(actionState, "dependencies");
  const packageDirectory = path.join(root, "model-package");
  const modelDirectory = path.join(packageDirectory, "models");
  const python = path.join(root, process.platform === "win32" ? "python.exe" : "python");
  const model = path.join(modelDirectory, "Qwen3.8-27B-ZeroRefusal-UD-IQ4_XS-V3-Final-MTP.gguf");
  const mmproj = path.join(packageDirectory, "Qweb3.8-mmproj-BF16.gguf");
  const previous = new Map([
    ["MODEL_ROUTER_STATE_DIR", process.env.MODEL_ROUTER_STATE_DIR],
    ["MODEL_ROUTER_LOCAL_GGUF_REGISTRY", process.env.MODEL_ROUTER_LOCAL_GGUF_REGISTRY],
    ["MODEL_ROUTER_LOCAL_GGUF_RUNTIME", process.env.MODEL_ROUTER_LOCAL_GGUF_RUNTIME],
  ]);
  try {
    await mkdir(path.join(dependencies, "llama_cpp"), { recursive: true });
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(path.join(dependencies, "llama_cpp", "__init__.py"), "# fixture\n");
    await writeFile(python, "fixture runtime\n");
    await writeFile(model, "fixture gguf\n");
    await writeFile(mmproj, "fixture vision projection\n");
    await writeFile(path.join(actionState, "config.json"), JSON.stringify({
      python,
      llmRoot: packageDirectory,
      llmModel: path.join("models", path.basename(model)),
      mmproj: path.basename(mmproj),
    }));
    process.env.MODEL_ROUTER_STATE_DIR = state;
    process.env.MODEL_ROUTER_LOCAL_GGUF_REGISTRY = path.join(state, "registry.json");
    process.env.MODEL_ROUTER_LOCAL_GGUF_RUNTIME = path.join(state, "runtime.json");
    const local = await import(`../src/local-gguf.mjs?test=${Date.now()}`);

    const discovery = local.discoverLocalGgufModels(root);
    assert.equal(discovery.candidates.length, 1);
    assert.equal(discovery.candidates[0].runnable, true);
    assert.equal(discovery.candidates[0].source, "action-studio");
    assert.equal(discovery.candidates[0].modelPath, model);
    assert.equal(discovery.candidates[0].displayName, "Qwen3.8 27B ZeroRefusal VL · 本地独立版");
    assert.equal(discovery.candidates[0].modelId, "qwen3.8-27b-zerorefusal-vl-local");
    assert.equal(discovery.candidates[0].tuningPreset, "qwen38-zerorefusal-vl-codex");
    assert.equal(discovery.candidates[0].mmprojPath, mmproj);
    assert.equal(discovery.candidates[0].serverPath, null);
    assert.equal(discovery.candidates[0].runtimeKind, "python-llama-cpp");
    assert.deepEqual(discovery.candidates[0].inputModalities, ["text", "image"]);
    assert.equal(discovery.candidates[0].thinkingEnabled, true);
    assert.equal(discovery.candidates[0].reasoningEffort, "xhigh");
    assert.deepEqual(discovery.candidates[0].reasoningLevels, ["low", "medium", "xhigh"]);
    assert.equal(discovery.candidates[0].contextWindow, 262144);
    assert.equal(discovery.candidates[0].temperature, 1);
    assert.equal(discovery.candidates[0].topP, 0.95);
    assert.equal(discovery.candidates[0].topK, 20);
    assert.equal(discovery.candidates[0].minP, 0);
    assert.equal(discovery.candidates[0].repeatPenalty, 1);
    assert.equal(discovery.candidates[0].frequencyPenalty, 0);
    assert.equal(discovery.candidates[0].presencePenalty, 0);
    assert.deepEqual(discovery.candidates[0].stopSequences, ["</s>"]);
    assert.equal("mmprojPath" in discovery.candidates[0], true);
    assert.doesNotMatch(JSON.stringify(discovery.candidates[0]), /minimax|h3-reference|prompt-rules|skills/i);

    const snapshot = await local.addLocalGgufModel(discovery.candidates[0]);
    assert.equal(snapshot.models.length, 1);
    assert.equal(snapshot.models[0].published, false);
    assert.equal(snapshot.models[0].status, "stopped");
    assert.equal(snapshot.models[0].available, true);
    assert.equal(snapshot.models[0].tuningPreset, "qwen38-zerorefusal-vl-codex");
    assert.equal(snapshot.models[0].mmprojPath, mmproj);
    assert.equal(snapshot.models[0].serverPath, null);
    assert.equal(snapshot.models[0].runtimeKind, "python-llama-cpp");
    assert.deepEqual(snapshot.models[0].inputModalities, ["text", "image"]);
    assert.deepEqual(snapshot.models[0].reasoningLevels, ["low", "medium", "xhigh"]);
    assert.deepEqual(snapshot.models[0].stopSequences, ["</s>"]);
    assert.equal(snapshot.security.binding, "127.0.0.1");
    assert.equal(snapshot.security.uploads, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /"(?:token|secret)"\s*:/i);
    const registry = JSON.parse(await readFile(process.env.MODEL_ROUTER_LOCAL_GGUF_REGISTRY, "utf8"));
    assert.equal(registry.models[0].modelPath, model);
    // Startup status is persisted by the backend, not by a mounted React page.
    let checks = 0;
    await assert.rejects(local.startLocalGgufModel(snapshot.models[0].id, {
      canStart: () => { if (++checks > 1) throw new Error("fixture startup timed out"); return true; },
    }), /timed out/);
    const afterTimeout = await local.localGgufSnapshot();
    assert.equal(afterTimeout.models[0].startup.state, "timeout");
    assert.ok(afterTimeout.models[0].startup.finishedAt);
    assert.equal((await local.localGgufSnapshot()).models[0].startup.state, "timeout");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
