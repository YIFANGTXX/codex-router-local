# Cross-model context continuity

## Contract

Codex's local session is the sole canonical history. Codex Router may derive a
provider-specific view of that history while serving a request, but it must
not write, replace, or normalize the stored session. No upstream response id,
provider cache, or LiteLLM deployment session is required to continue a task.

For every ordinary `/responses` request:

1. Codex supplies the cumulative local transcript.
2. The router keeps that payload pristine for routing and failover.
3. Each attempted route gets a newly derived input, including only the
   compatibility transforms required by that provider.
4. The derived upstream request uses `store: false` and omits
   `previous_response_id`.
5. If the user changes models, the next provider receives a new projection of
   the same cumulative Codex history.

`/responses/compact` remains a separate Codex protocol. Router-managed external
compaction is also built from the complete local transcript; the native compact
endpoint keeps its upstream contract so Codex can replace local history with
the compact result in the normal way.

## Why provider-side chaining is not canonical

A `previous_response_id` belongs to one provider, account, deployment, and
often one model family. Forwarding it after a model switch can reject the turn,
retrieve a different server-side history, or silently omit tool traffic. Even
when a provider supports response chaining, it is only an optimization and
cannot be the authority for a portable Codex task.

## Acceptance gates

The offline gate, `test/context-continuity.test.mjs`, starts mock external and
native endpoints and sends three cumulative turns:

1. external model A;
2. external model B, including A's answer;
3. native GPT, including A and B's answers.

The transcript includes user and assistant messages, a function call and its
result, and a subagent handoff. The test verifies all prior markers arrive at
each applicable provider, every request is stateless, the native return
normalizes the provider-authored subagent payload, and the fake Codex session
tree has neither byte nor metadata changes.

The optional billed live gate is:

```sh
./bin/test-model MODEL_A --switch-to MODEL_B --return-to NATIVE_GPT --live --yes
```

It seeds a marker on A, continues from the cumulative transcript on B, then
returns to native GPT and requires the same marker at every stage. Run the
offline gate on every change; run the live gate before certifying a new
provider adapter.
