# Base selection and gap analysis

Assessment date: 2026-08-29.

## Non-negotiable acceptance criteria

- Codex's local task is the only canonical conversation history.
- Switching A → B → native GPT must continue the same task with the complete
  cumulative context, including tool calls and subagent handoffs.
- The integration must preserve Codex's own agent loop, shell, patch, MCP,
  permissions, and subagents.
- No external provider, anonymous endpoint, model, or credential is trusted or
  active by default. Every outbound destination is created by the user.
- The router may derive a provider-specific request at read time, but it may not
  edit, migrate, or replace Codex session files.

## Compared foundations

| Candidate | What it already solves | Gaps against this product | Decision |
| --- | --- | --- | --- |
| Existing Codex Router | Codex Responses ingress, native model-catalog merge, loopback caller authentication, native GPT pass-through, credential isolation, protocol translation, health/service plumbing, and native model-picker integration. Its documented architecture also leaves tools and task state in Codex. | The original product surface centers a checked-in provider catalog, exposes provider/model discovery, and requires a restart when new catalog entries are published. Its prior UI is broader than a small user-owned switch shell. | **Use as the base.** Keep the proven Codex boundary and replace the ordinary user flow with local connection CRUD and an explicit trusted-route policy. |
| LiteLLM Proxy/Router alone | Broad protocol normalization, `/v1/responses`, load balancing, retries, cooldowns, and configurable fallbacks. | It is a general gateway, not a Codex integration: it does not own Codex's native catalog merge, ChatGPT/native GPT pass-through, project defaults, caller capability URL, or the required local-history contract. Its optional logging, budgets, teams, and database surface add complexity this personal shell does not need. | Keep the existing locked translation dependency where needed; do not make LiteLLM the product or history authority. |
| Provider switchers that rewrite Codex config/history | Small UI or script and quick `model_provider` changes. | Changing `model_provider`, `auth.json`, or stored session references makes the provider identity part of continuity. History migration directly violates the “Codex local history is canonical and untouched” rule and is fragile across tool-call dialects. | Reject as the base. Do not mutate session history to make a provider switch appear continuous. |
| New router from scratch | Could start with a minimal surface. | Would have to recreate Responses streaming, catalog compatibility, native GPT relay, compaction, caller authentication, service lifecycle, tool-call mapping, and the accumulated tests. | Reject; it duplicates the highest-risk parts of Codex Router. |

Sources: [Codex Router architecture](https://github.com/duolahypercho/codex-router/blob/main/docs/HOW-IT-WORKS.md),
[Codex Router development guide](https://github.com/duolahypercho/codex-router/blob/main/docs/DEVELOPMENT.md),
[LiteLLM architecture](https://github.com/BerriAI/litellm/blob/main/ARCHITECTURE.md), and
[an example config/history-writing provider switcher](https://github.com/Mykeyb2004/codex-provider-switcher).

## Gaps closed in this implementation

| Gap | Implementation |
| --- | --- |
| User-owned connections only | `src/connections.mjs` and `src/generic-providers.mjs` create, edit, test, disable, and remove only user-entered endpoints and model IDs. The new Control Center does not show the checked-in provider catalog. |
| No secret in argv or catalog | The Electron boundary sends credentials through standard input. Protected credential files are referenced by ID; snapshots and the model registry stay redacted. |
| Stable Codex boundary | Codex continues to use one loopback router and its native picker. A new model ID requires one catalog reload; switching among already-published models stays in the same task. |
| Cross-model history continuity | Routed and native ordinary requests are rebuilt from Codex's cumulative input with `store: false` and no `previous_response_id`. `test/context-continuity.test.mjs` verifies A → B → native GPT and asserts that the fake Codex session tree is byte-for-byte and metadata unchanged. |
| Trusted fallback | `src/model-failover.mjs` applies a bounded, explicit user-created chain only after eligible pre-response 429/5xx failures. |
| Project default | `src/project-route.mjs` owns only a marked local config block and refuses to overwrite project-owned settings. |
| Health and compatibility | The connection shell performs a bounded endpoint health test, while the existing compatibility harness remains available for opt-in live protocol/tool checks. |

## Remaining platform constraint

Codex loads a newly generated model catalog at application startup. Therefore,
publishing a brand-new model ID requires fully quitting and reopening Codex once.
This is not a conversation migration: after the entry is loaded, selecting it in
the current task uses Codex's existing local history. No router-side session is
created for the switch.
