import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addGenericProvider,
  genericProviderCredentialStatus,
  getGenericProvider,
  listGenericProviders,
  removeGenericProvider,
  setGenericProviderEnabled,
  testGenericProvider,
  updateGenericProvider,
} from "./generic-providers.mjs";
import { discoverGenericProviderModels } from "./model-discovery.mjs";
import {
  addGenericProviderCredentialReference,
  removeCredentialReference,
} from "./provider-credential-store.mjs";
import {
  genericProviderCredentialPath,
  removeGenericProviderCredential,
  writeGenericProviderCredential,
} from "./provider-credentials.mjs";
import {
  GENERIC_PROVIDERS_PATH,
  PROVIDER_CREDENTIAL_STORE_PATH,
  PROVIDER_SELECTION_PATH,
} from "./paths.mjs";
import { writePrivateJson } from "./file-security.mjs";
import {
  USER_MODELS_PATH,
  readUserModels,
  userModelEntry,
  writeUserModels,
} from "./user-models.mjs";
import { transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { MODEL_PICKER_STATE_PATH, setModelsVisible } from "./model-picker-state.mjs";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,200}$/;

function text(value, field, limit = 240) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} is required.`);
  if (result.length > limit) throw new Error(`${field} is too long.`);
  return result;
}

function modelId(value) {
  const result = text(value, "Model id", 201);
  if (!MODEL_ID.test(result)) throw new Error("Model id contains unsupported characters.");
  return result;
}

function selectedProviderIds() {
  if (!existsSync(PROVIDER_SELECTION_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8"));
    return parsed?.version === 1 && Array.isArray(parsed.providers)
      ? parsed.providers.map(String).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeSelectedProviderIds(ids) {
  writePrivateJson(PROVIDER_SELECTION_PATH, {
    version: 1,
    providers: [...new Set(ids.map(String).filter(Boolean))],
  });
}

function setSelected(providerId, selected) {
  const current = selectedProviderIds().filter((id) => id !== providerId);
  writeSelectedProviderIds(selected ? [...current, providerId] : current);
}

function modelsFor(providerId) {
  return readUserModels().filter((model) => model?.provider === providerId);
}

function connectionFiles(providerId) {
  return [
    GENERIC_PROVIDERS_PATH,
    PROVIDER_CREDENTIAL_STORE_PATH,
    PROVIDER_SELECTION_PATH,
    USER_MODELS_PATH,
    MODEL_PICKER_STATE_PATH,
    genericProviderCredentialPath(providerId),
  ];
}

function addModelEntries(
  providerId,
  upstreamIds,
  { displayName, contextWindow, modelProfile, replaceExisting = false } = {},
) {
  const provider = getGenericProvider(providerId);
  if (!provider.enabled) throw new Error(`Connection ${providerId} is disabled.`);
  const ids = [...new Set(upstreamIds.map(modelId))];
  const current = readUserModels();
  const identities = new Set(current.map((model) => `${model?.provider}\0${model?.upstreamModel}`));
  let priority = Math.max(0, ...current.map((model) => Number(model?.priority) || 0)) + 1;
  const added = [];
  for (const upstreamId of ids) {
    const identity = `${providerId}\0${upstreamId}`;
    const existingIndex = current.findIndex(
      (model) => `${model?.provider}\0${model?.upstreamModel}` === identity,
    );
    if (existingIndex !== -1 && !replaceExisting) continue;
    const metadata = {
      ...(Number.isInteger(contextWindow) && contextWindow > 0 ? {
          contextWindow,
          autoCompact: Math.max(1, Math.floor(contextWindow * 0.84)),
        } : {}),
      ...(modelProfile?.metadata && typeof modelProfile.metadata === "object"
        ? modelProfile.metadata
        : {}),
    };
    const entry = userModelEntry({
      providerId,
      upstreamId,
      priority: existingIndex === -1
        ? priority++
        : Number(current[existingIndex]?.priority) || priority++,
      metadata,
      requestProfile: modelProfile?.requestProfile,
    });
    // A user-created connection must show the exact upstream model id by
    // default. "(curated)" is registry terminology and made a provider-owned
    // model look like a locally invented name in Codex's picker.
    const modelDisplayName = modelProfile?.displayName || displayName;
    entry.displayName = modelDisplayName && ids.length === 1
      ? text(modelDisplayName, "Model name", 120)
      : upstreamId;
    if (existingIndex === -1) current.push(entry);
    else current[existingIndex] = entry;
    identities.add(identity);
    added.push(entry);
  }
  writeUserModels(current);
  // Adding a model through a connection must select it for the picker, exactly
  // as CLI curation does (`curate-models.mjs` calls setModelsVisible after the
  // write). A connection's model would otherwise be published but stay out of
  // the explicit `visible` allowlist, which a signed-in Codex renders as
  // `visibility: "hide"` no matter how often Codex is restarted.
  if (added.length) setModelsVisible(added.map((model) => model.slug), true);
  return added;
}

function removeModelEntries(providerId, upstreamIds) {
  const targets = new Set(upstreamIds.map(modelId));
  const current = readUserModels();
  const removed = current.filter(
    (model) => model?.provider === providerId && targets.has(model?.upstreamModel),
  );
  writeUserModels(current.filter(
    (model) => !(model?.provider === providerId && targets.has(model?.upstreamModel)),
  ));
  return removed;
}

function attachCredential(providerId, secret) {
  const value = text(secret, "API key", 16 * 1024);
  const provider = getGenericProvider(providerId);
  let credentialRef = provider.credentialRef;
  if (!credentialRef) {
    const credential = addGenericProviderCredentialReference({
      providerId,
      label: `${provider.displayName} API key`,
    });
    credentialRef = credential.id;
  }
  writeGenericProviderCredential(providerId, value);
  updateGenericProvider(providerId, { credentialRef });
  return credentialRef;
}

function detachCredential(providerId) {
  const provider = getGenericProvider(providerId);
  removeGenericProviderCredential(providerId);
  if (provider.credentialRef) removeCredentialReference(provider.credentialRef);
  updateGenericProvider(providerId, { credentialRef: undefined });
}

export function connectionsSnapshot() {
  const selected = new Set(selectedProviderIds());
  return {
    version: 1,
    security: {
      canonicalHistory: "codex-local",
      keys: "protected-local-files",
      externalDefaults: 0,
      note: "Only connections created on this device are shown or routed.",
    },
    connections: listGenericProviders({ redacted: true }).map((provider) => {
      const credential = genericProviderCredentialStatus(provider.id);
      return {
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        adapter: provider.adapter,
        allowPrivate: provider.allowPrivate,
        enabled: provider.enabled && selected.has(provider.id),
        credential: {
          required: Boolean(provider.credentialRef),
          configured: credential.configured,
          source: credential.source || null,
        },
        models: modelsFor(provider.id).map((model) => ({
          id: model.upstreamModel,
          slug: model.slug,
          name: model.displayName,
          contextWindow: model.contextWindow,
        })),
      };
    }),
  };
}

export async function addConnection({
  id,
  name,
  baseUrl,
  adapter = "openai-chat",
  allowPrivate = false,
  apiKey,
  models = [],
  contextWindow,
  modelProfile,
} = {}) {
  const providerId = text(id, "Connection id", 80);
  const upstreamModels = models.map(modelId);
  await transactModelOverlayMutation({
    files: connectionFiles(providerId),
    restart: true,
    mutate: async () => {
      addGenericProvider({
        id: providerId,
        displayName: text(name, "Connection name", 120),
        baseUrl: text(baseUrl, "Base URL", 2_000),
        adapter,
        allowPrivate: Boolean(allowPrivate),
      });
      if (apiKey !== undefined && String(apiKey).trim()) attachCredential(providerId, apiKey);
      if (upstreamModels.length) addModelEntries(providerId, upstreamModels, { contextWindow, modelProfile });
      setSelected(providerId, true);
    },
  });
  return connectionsSnapshot();
}

export async function updateConnection(providerId, {
  name,
  baseUrl,
  adapter,
  allowPrivate,
} = {}) {
  const id = text(providerId, "Connection id", 80);
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    restart: true,
    mutate: async () => {
      updateGenericProvider(id, {
        displayName: text(name, "Connection name", 120),
        baseUrl: text(baseUrl, "Base URL", 2_000),
        adapter,
        allowPrivate: Boolean(allowPrivate),
      });
    },
  });
  return connectionsSnapshot();
}

export async function addConnectionModels(providerId, models, options = {}) {
  const id = text(providerId, "Connection id", 80);
  let added;
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    restart: true,
    mutate: async () => {
      added = addModelEntries(id, models, options);
      setSelected(id, true);
    },
  });
  return { ...connectionsSnapshot(), added: added.map((model) => model.slug) };
}

export async function removeConnectionModels(providerId, models) {
  const id = text(providerId, "Connection id", 80);
  let removed;
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    restart: true,
    mutate: async () => {
      removed = removeModelEntries(id, models);
      if (!modelsFor(id).length) setSelected(id, false);
    },
  });
  return { ...connectionsSnapshot(), removed: removed.map((model) => model.slug) };
}

export async function setConnectionEnabled(providerId, enabled) {
  const id = text(providerId, "Connection id", 80);
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    restart: true,
    mutate: async () => {
      setGenericProviderEnabled(id, Boolean(enabled));
      setSelected(id, Boolean(enabled));
    },
  });
  return connectionsSnapshot();
}

export async function setConnectionCredential(providerId, secret) {
  const id = text(providerId, "Connection id", 80);
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    mutate: async () => attachCredential(id, secret),
  });
  return connectionsSnapshot();
}

export async function clearConnectionCredential(providerId) {
  const id = text(providerId, "Connection id", 80);
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    mutate: async () => detachCredential(id),
  });
  return connectionsSnapshot();
}

export async function deleteConnection(providerId) {
  const id = text(providerId, "Connection id", 80);
  await transactModelOverlayMutation({
    files: connectionFiles(id),
    restart: true,
    mutate: async () => {
      const provider = getGenericProvider(id);
      writeUserModels(readUserModels().filter((model) => model?.provider !== id));
      setSelected(id, false);
      removeGenericProviderCredential(id);
      if (provider.credentialRef) removeCredentialReference(provider.credentialRef);
      removeGenericProvider(id);
    },
  });
  return connectionsSnapshot();
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values.filter((value) => value !== undefined);
}

async function readSecret() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("The API key is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(args = process.argv.slice(2)) {
  const action = args[0] || "list";
  let result;
  if (action === "list") {
    result = connectionsSnapshot();
  } else if (action === "add") {
    result = await addConnection({
      id: args[1],
      name: option(args, "--name"),
      baseUrl: option(args, "--base-url"),
      adapter: option(args, "--adapter") || "openai-chat",
      allowPrivate: args.includes("--allow-private"),
      apiKey: args.includes("--with-key") ? await readSecret() : undefined,
      models: options(args, "--model"),
      contextWindow: option(args, "--context-window")
        ? Number(option(args, "--context-window"))
        : undefined,
    });
  } else if (action === "model-add") {
    result = await addConnectionModels(args[1], options(args, "--model"), {
      contextWindow: option(args, "--context-window")
        ? Number(option(args, "--context-window"))
        : undefined,
    });
  } else if (action === "model-remove") {
    result = await removeConnectionModels(args[1], options(args, "--model"));
  } else if (action === "enable" || action === "disable") {
    result = await setConnectionEnabled(args[1], action === "enable");
  } else if (action === "key-set") {
    result = await setConnectionCredential(args[1], await readSecret());
  } else if (action === "key-clear") {
    result = await clearConnectionCredential(args[1]);
  } else if (action === "test") {
    result = await testGenericProvider(args[1]);
  } else if (action === "edit") {
    result = await updateConnection(args[1], {
      name: option(args, "--name"),
      baseUrl: option(args, "--base-url"),
      adapter: option(args, "--adapter") || "openai-chat",
      allowPrivate: args.includes("--allow-private"),
    });
  } else if (action === "discover-models") {
    result = await discoverGenericProviderModels(args[1], { refresh: true });
  } else if (action === "remove") {
    result = await deleteConnection(args[1]);
  } else {
    throw new Error(
      "Usage: connections list|add ID --name NAME --base-url URL --model MODEL [--with-key] | " +
      "model-add ID --model MODEL | model-remove ID --model MODEL | enable ID | disable ID | " +
      "key-set ID | key-clear ID | test ID | remove ID",
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
