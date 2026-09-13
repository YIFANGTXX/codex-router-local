import assert from "node:assert/strict";
import test from "node:test";

import { apiForwarderHealthPayload } from "../src/api-forwarder-health.mjs";

const generic = { id: "my-api", kind: "openai-compatible", generic: true };

test("API forwarder health stays live when mutable provider state cannot be read", () => {
  const payload = apiForwarderHealthPayload({
    providers: new Map([[generic.id, generic]]),
    readSelection: () => [generic.id],
    credentialStatus: () => ({ configured: true }),
    genericCredentialStatus: () => { throw new Error("changed while process was running"); },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.service, "codex-router-api-forwarder");
  assert.equal(payload.configuration, "partially-unavailable");
  assert.deepEqual(payload.providers[generic.id], {
    credential_present: false,
    status: "configuration-unavailable",
  });
});

test("API forwarder health remains live when provider selection is temporarily unreadable", () => {
  const payload = apiForwarderHealthPayload({
    providers: new Map(),
    readSelection: () => { throw new Error("temporary read failure"); },
    credentialStatus: () => ({ configured: true }),
    genericCredentialStatus: () => ({ configured: true }),
  });

  assert.deepEqual(payload, {
    ok: true,
    service: "codex-router-api-forwarder",
    providers: {},
    configuration: "unavailable",
  });
});
