const SERVICE = "codex-router-api-forwarder";

// Liveness must not fail because one provider's mutable local configuration
// changed after this process started. Routing still fails closed at the
// request boundary, while /health remains an honest answer about whether the
// local forwarder itself can receive requests.
export function apiForwarderHealthPayload({
  providers,
  readSelection,
  credentialStatus,
  genericCredentialStatus,
} = {}) {
  const result = {};
  let enabled;
  try {
    enabled = new Set(readSelection());
  } catch {
    return {
      ok: true,
      service: SERVICE,
      providers: result,
      configuration: "unavailable",
    };
  }

  let configurationUnavailable = false;
  for (const provider of providers.values()) {
    if (provider.kind !== "openai-compatible" || !enabled.has(provider.id)) continue;
    try {
      const status = provider.generic === true
        ? genericCredentialStatus(provider.id)
        : credentialStatus(provider);
      result[provider.id] = {
        credential_present: status.configured,
        ...(status.configured
          ? { credential_source: status.source }
          : { setup: status.setup }),
      };
    } catch {
      configurationUnavailable = true;
      result[provider.id] = {
        credential_present: false,
        status: "configuration-unavailable",
      };
    }
  }

  return {
    ok: true,
    service: SERVICE,
    providers: result,
    ...(configurationUnavailable ? { configuration: "partially-unavailable" } : {}),
  };
}
