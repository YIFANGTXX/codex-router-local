import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { modelPickerSnapshot } from "./model-picker-state.mjs";
import { scanTomlDocument } from "./toml-structure.mjs";

const START_MARKER = "# BEGIN codex-router-project-route";
const END_MARKER = "# END codex-router-project-route";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/;

function projectPaths(project) {
  const root = path.resolve(String(project || process.cwd()));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project directory does not exist: ${root}`);
  }
  return {
    root,
    directory: path.join(root, ".codex"),
    config: path.join(root, ".codex", "config.toml"),
  };
}

function assertSafeProjectConfig(paths) {
  if (existsSync(paths.directory)) {
    const directory = lstatSync(paths.directory);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error(`Refusing non-directory or linked project config path: ${paths.directory}`);
    }
  }
  if (existsSync(paths.config)) {
    const config = lstatSync(paths.config);
    if (config.isSymbolicLink() || !config.isFile()) {
      throw new Error(`Refusing non-file or linked project config: ${paths.config}`);
    }
  }
}

function rootModelAssignments(contents) {
  return scanTomlDocument(contents).assignments.filter(
    ({ tablePath, key }) =>
      tablePath.length === 0 && key.length === 1 && key[0] === "model",
  );
}

function managedPrefix(contents) {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? contents.slice(1) : contents;
  const starts = body.split(/\r?\n/u).filter((line) => line.trim() === START_MARKER).length;
  const ends = body.split(/\r?\n/u).filter((line) => line.trim() === END_MARKER).length;
  if (starts === 0 && ends === 0) return undefined;
  if (starts !== 1 || ends !== 1) {
    throw new Error("Refusing ambiguous Codex Router project-route markers.");
  }
  const match = new RegExp(
    `^${START_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\r?\\n` +
      `model = "([A-Za-z0-9][A-Za-z0-9._:/+\\-]*)"\\r?\\n` +
      `${END_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\r?\\n`,
    "u",
  ).exec(body);
  if (!match) {
    throw new Error(
      "Refusing an edited project-route block. Restore or remove both marker lines manually.",
    );
  }
  const assignments = rootModelAssignments(contents);
  const managed = assignments.filter(({ index }) => index === 1);
  const outside = assignments.filter(({ index }) => index !== 1);
  if (managed.length !== 1 || outside.length) {
    throw new Error("Refusing duplicate project-level model assignments.");
  }
  return {
    bom,
    model: match[1],
    length: match[0].length,
    remainder: body.slice(match[0].length),
  };
}

function atomicWrite(paths, contents) {
  mkdirSync(paths.directory, { recursive: true, mode: 0o755 });
  assertSafeProjectConfig(paths);
  const mode = existsSync(paths.config) ? statSync(paths.config).mode & 0o777 : 0o644;
  const temporary = path.join(paths.directory, `.config.toml.tmp.${process.pid}.${randomUUID()}`);
  writeFileSync(temporary, contents, { encoding: "utf8", mode });
  try {
    renameSync(temporary, paths.config);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function availableProjectModels() {
  const picker = modelPickerSnapshot();
  return selectedConfiguredListedModels()
    .filter((model) =>
      picker.hasExplicitVisibility
        ? picker.visible.includes(model.slug)
        : !picker.hidden.includes(model.slug),
    )
    .map((model) => model.slug);
}

export function projectRouteSnapshot(project = process.cwd()) {
  const paths = projectPaths(project);
  assertSafeProjectConfig(paths);
  if (!existsSync(paths.config)) {
    return { project: paths.root, path: paths.config, managed: false };
  }
  const contents = readFileSync(paths.config, "utf8");
  const managed = managedPrefix(contents);
  const rootModels = rootModelAssignments(contents);
  return {
    project: paths.root,
    path: paths.config,
    managed: Boolean(managed),
    ...(managed ? { model: managed.model } : {}),
    ...(managed || rootModels.length === 0
      ? {}
      : { existingModel: rootModels[0].kind === "string" ? rootModels[0].value : null }),
  };
}

export function setProjectRoute(
  project,
  model,
  { allowedModels = availableProjectModels() } = {},
) {
  const value = String(model || "").trim();
  if (!MODEL_PATTERN.test(value)) throw new Error(`Invalid router model slug: ${value || "(empty)"}`);
  if (!new Set(allowedModels).has(value)) {
    throw new Error(
      `${value} is not an enabled, authenticated external model selected for the Codex picker.`,
    );
  }

  const paths = projectPaths(project);
  assertSafeProjectConfig(paths);
  const contents = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const managed = managedPrefix(contents);
  if (!managed && rootModelAssignments(contents).length) {
    throw new Error(
      `Project already owns its root model setting in ${paths.config}; refusing to overwrite it.`,
    );
  }
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const bom = managed?.bom ?? (contents.startsWith("\uFEFF") ? "\uFEFF" : "");
  const remainder = managed
    ? managed.remainder
    : bom
      ? contents.slice(1)
      : contents;
  const block = [START_MARKER, `model = ${JSON.stringify(value)}`, END_MARKER, ""].join(eol);
  atomicWrite(paths, `${bom}${block}${remainder}`);
  return projectRouteSnapshot(paths.root);
}

export function clearProjectRoute(project = process.cwd()) {
  const paths = projectPaths(project);
  assertSafeProjectConfig(paths);
  if (!existsSync(paths.config)) return projectRouteSnapshot(paths.root);
  const contents = readFileSync(paths.config, "utf8");
  const managed = managedPrefix(contents);
  if (!managed) return projectRouteSnapshot(paths.root);
  const restored = `${managed.bom}${managed.remainder}`;
  if (restored === "" || restored === "\uFEFF") unlinkSync(paths.config);
  else atomicWrite(paths, restored);
  return projectRouteSnapshot(paths.root);
}

function cliArguments(argv) {
  const positional = [];
  let project = process.cwd();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project") {
      project = argv[++index];
      if (!project) throw new Error("--project requires a directory.");
    } else if (argv[index] === "--json") {
      json = true;
    } else {
      positional.push(argv[index]);
    }
  }
  return { positional, project, json };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.managed) process.stdout.write(`Project route: ${result.model}\n`);
  else if (Object.hasOwn(result, "existingModel")) {
    process.stdout.write(`Project route: unmanaged (${result.existingModel ?? "non-string model"})\n`);
  } else process.stdout.write("Project route: global default\n");
  process.stdout.write(`Config: ${result.path}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { positional, project, json } = cliArguments(process.argv.slice(2));
    const action = positional[0] || "status";
    let result;
    if (action === "status" && positional.length === 1) {
      result = projectRouteSnapshot(project);
    } else if (action === "set" && positional.length === 2) {
      result = setProjectRoute(project, positional[1]);
    } else if (action === "clear" && positional.length === 1) {
      result = clearProjectRoute(project);
    } else {
      throw new Error(
        "Usage: project-route status|set MODEL|clear [--project DIRECTORY] [--json]",
      );
    }
    printResult(result, json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
