import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearProjectRoute,
  projectRouteSnapshot,
  setProjectRoute,
} from "../src/project-route.mjs";

const MODEL_A = "deepseek/deepseek-v4-flash";
const MODEL_B = "anthropic-api/claude-opus-4.8";

function projectFixture(contents) {
  const project = mkdtempSync(path.join(os.tmpdir(), "codex-project-route-"));
  if (contents !== undefined) {
    mkdirSync(path.join(project, ".codex"), { recursive: true });
    writeFileSync(path.join(project, ".codex", "config.toml"), contents, "utf8");
  }
  return project;
}

test("project route owns only a marked root model and restores the config byte-for-byte", () => {
  const original = "\uFEFF[features]\r\nmulti_agent = true\r\n";
  const project = projectFixture(original);
  try {
    const first = setProjectRoute(project, MODEL_A, { allowedModels: [MODEL_A, MODEL_B] });
    assert.equal(first.managed, true);
    assert.equal(first.model, MODEL_A);
    const configured = readFileSync(first.path, "utf8");
    assert.match(
      configured,
      /^\uFEFF# BEGIN codex-router-project-route\r\nmodel = "deepseek\/deepseek-v4-flash"\r\n# END codex-router-project-route\r\n/u,
    );
    assert.ok(configured.endsWith(original.slice(1)));

    const second = setProjectRoute(project, MODEL_B, { allowedModels: [MODEL_A, MODEL_B] });
    assert.equal(second.model, MODEL_B);
    assert.equal(
      (readFileSync(second.path, "utf8").match(/BEGIN codex-router-project-route/gu) || []).length,
      1,
    );

    const cleared = clearProjectRoute(project);
    assert.equal(cleared.managed, false);
    assert.equal(readFileSync(cleared.path, "utf8"), original);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project route removes a config file that contained only its managed default", () => {
  const project = projectFixture();
  try {
    const set = setProjectRoute(project, MODEL_A, { allowedModels: [MODEL_A] });
    assert.equal(existsSync(set.path), true);
    const cleared = clearProjectRoute(project);
    assert.equal(cleared.managed, false);
    assert.equal(existsSync(cleared.path), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project route refuses to overwrite a project-owned root model", () => {
  const project = projectFixture('model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = true\n');
  try {
    const status = projectRouteSnapshot(project);
    assert.equal(status.managed, false);
    assert.equal(status.existingModel, "gpt-5.6-sol");
    assert.throws(
      () => setProjectRoute(project, MODEL_A, { allowedModels: [MODEL_A] }),
      /already owns its root model setting/u,
    );
    assert.equal(
      readFileSync(status.path, "utf8"),
      'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = true\n',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project route fails closed when its managed block was edited", () => {
  const project = projectFixture(
    "# BEGIN codex-router-project-route\n# hand edited\nmodel = \"deepseek/deepseek-v4-flash\"\n# END codex-router-project-route\n",
  );
  try {
    assert.throws(() => projectRouteSnapshot(project), /edited project-route block/u);
    assert.throws(() => clearProjectRoute(project), /edited project-route block/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project route accepts only an enabled authenticated external model", () => {
  const project = projectFixture();
  try {
    assert.throws(
      () => setProjectRoute(project, MODEL_A, { allowedModels: [] }),
      /not an enabled, authenticated external model selected for the Codex picker/u,
    );
    assert.throws(
      () => setProjectRoute(project, "../../escape", { allowedModels: ["../../escape"] }),
      /Invalid router model slug/u,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
