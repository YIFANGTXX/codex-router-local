import { PROVIDERS } from "./model-registry.mjs";

export const GENERIC_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeGenericProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  if (!GENERIC_PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("Provider id must match [a-z0-9][a-z0-9-]*.");
  }
  // model-registry also reads user-created providers while it is initializing.
  // During that one cycle the live ESM binding is still in its temporal dead
  // zone; model-registry performs the same collision check before merging the
  // descriptor. Every mutation after startup still checks the settled map here.
  let builtInProviders;
  try {
    builtInProviders = PROVIDERS;
  } catch (error) {
    if (!(error instanceof ReferenceError)) throw error;
  }
  if (builtInProviders?.has(providerId) && builtInProviders.get(providerId)?.generic !== true) {
    throw new Error(`Provider id ${providerId} is already used by the built-in registry.`);
  }
  return providerId;
}
