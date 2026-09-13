import assert from "node:assert/strict";
import test from "node:test";
import { identifyRegisteredLlama } from "../src/local-gguf-process.mjs";

const model = { serverPath: "C:\\router\\llama-server.exe", modelPath: "C:\\Models\\qwen.gguf", modelId: "qwen-local", port: 4268 };
const command = '"C:\\router\\llama-server.exe" --model "C:\\Models\\qwen.gguf" --alias qwen-local';
test("orphan recovery identifies only the registered executable and model, before authentication", () => {
  const dependencies = { findPid: () => 1234, identity: () => "start-time|executable", commandLine: () => command };
  assert.deepEqual(identifyRegisteredLlama(model, dependencies), { pid: 1234, processIdentity: "start-time|executable" });
  for (const wrong of [command.replace("llama-server", "unrelated"), command.replace("qwen.gguf", "other.gguf"), command.replace("qwen-local", "other-model")]) {
    assert.equal(identifyRegisteredLlama(model, { ...dependencies, commandLine: () => wrong }), undefined);
  }
  assert.equal(identifyRegisteredLlama(model, { ...dependencies, identity: () => undefined }), undefined);
  assert.equal(identifyRegisteredLlama(model, { ...dependencies, findPid: () => undefined }), undefined);
});
