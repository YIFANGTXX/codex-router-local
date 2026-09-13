import { existsSync, readFileSync } from "node:fs";

import { GENERIC_PROVIDERS_PATH } from "./paths.mjs";

const ADAPTERS = new Set(["openai-chat", "openai-responses", "openai-completions"]);
const ID = /^[a-z0-9][a-z0-9-]*$/;
const CREDENTIAL_REF = /^cred_[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SECRET_HEADER = /(?:^|[-_])(auth|authorization|api[-_]?key|key|token|secret|credential|cookie|password|session|signature)(?:$|[-_])/i;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

function invalid(message) {
  throw new Error(`Invalid generic provider state ${GENERIC_PROVIDERS_PATH}: ${message}`);
}

function normalizeProvider(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("provider must be an object");
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID.test(id)) invalid("provider id must match [a-z0-9][a-z0-9-]*");
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName || displayName.length > 120) invalid(`provider ${id} has an invalid displayName`);
  const adapter = typeof raw.adapter === "string" ? raw.adapter.trim() : "";
  if (!ADAPTERS.has(adapter)) invalid(`provider ${id} has an unsupported adapter`);
  if (typeof raw.allowPrivate !== "boolean" || typeof raw.enabled !== "boolean") {
    invalid(`provider ${id} has invalid state flags`);
  }
  let endpoint;
  try {
    endpoint = new URL(raw.baseUrl);
  } catch {
    invalid(`provider ${id} has an invalid baseUrl`);
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    invalid(`provider ${id} has an unsafe baseUrl`);
  }
  if (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers)) {
    invalid(`provider ${id} headers must be an object`);
  }
  const headerNames = Object.keys(raw.headers);
  if (headerNames.length > 64) invalid(`provider ${id} has too many headers`);
  for (const name of headerNames) {
    const lower = name.toLowerCase();
    const value = raw.headers[name];
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lower) || SECRET_HEADER.test(lower)) {
      invalid(`provider ${id} has a reserved header`);
    }
    if (typeof value !== "string" || !value || value.length > 4_096 || /[\r\n]/.test(value)) {
      invalid(`provider ${id} has an invalid header value`);
    }
  }
  if (raw.credentialRef !== undefined && !CREDENTIAL_REF.test(raw.credentialRef)) {
    invalid(`provider ${id} has an invalid credentialRef`);
  }
  return {
    id,
    displayName,
    kind: "openai-compatible",
    ownedBy: id,
    baseUrl: String(raw.baseUrl).replace(/\/+$/, ""),
    adapter,
    protocol: adapter === "openai-responses" ? "openai-responses" : "openai",
    headers: Object.fromEntries(headerNames.map((name) => [name, "[redacted]"])),
    allowPrivate: raw.allowPrivate,
    enabled: raw.enabled,
    ...(raw.credentialRef ? { credentialRef: raw.credentialRef } : {}),
    generic: true,
  };
}

// This is deliberately a read-only projection with no credential imports.
// model-registry loads it during startup; keeping secret resolution outside
// this dependency edge prevents a registry <-> credential-store module cycle.
export function runtimeGenericProviderDescriptors() {
  if (!existsSync(GENERIC_PROVIDERS_PATH)) return [];
  let document;
  try {
    document = JSON.parse(readFileSync(GENERIC_PROVIDERS_PATH, "utf8"));
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (document?.version !== 1 || !Array.isArray(document.providers)) {
    invalid("version must be 1 and providers must be an array");
  }
  const seen = new Set();
  return document.providers.map((provider) => {
    const descriptor = normalizeProvider(provider);
    if (seen.has(descriptor.id)) invalid(`duplicate provider id ${descriptor.id}`);
    seen.add(descriptor.id);
    return descriptor;
  });
}
