# Feature Parity Design

## Goal

Bring `openclaw-zulip-plus` to feature parity with the combined upstream capabilities in `upstream/`, while preserving the current plugin's strengths in resilience, tests, and action-adapter integration.

Success means:
- every meaningful upstream feature is either implemented or intentionally absorbed into an equivalent local abstraction;
- the current plugin remains the primary implementation rather than being replaced by a fork;
- the result stays testable, composable, and compatible with the existing OpenClaw channel/action model.

## Non-Goals

- Replacing the current architecture with `xyhost`'s tool-first architecture.
- Dropping existing safeguards such as dedupe, keepalive, crash recovery, or DM policy handling.
- Blindly mirroring upstream naming when a local name fits the current codebase better.

## Approaches Considered

### 1. Merge one upstream wholesale

Pros:
- fastest apparent route;
- fewer local design decisions.

Cons:
- no single upstream is actually more complete than this repo;
- would lose existing strengths like broader tests, stale cleanup, poll action, and current integration patterns;
- high regression risk.

Recommendation: reject.

### 2. Cherry-pick opportunistically from all upstreams

Pros:
- captures the best ideas from each fork;
- lower rewrite cost.

Cons:
- can become unstructured drift;
- risks inconsistent APIs and duplicated concepts.

Recommendation: use selectively, but only inside a structured local design.

### 3. Keep the current plugin as canonical and absorb missing features in batches

Pros:
- preserves the existing architecture;
- supports careful testing and phased rollout;
- lets parity features land without regressing current behavior.

Cons:
- more implementation work up front;
- requires disciplined sequencing.

Recommendation: choose this approach.

## Architecture

The current repo remains canonical. Parity work lands in six technical layers:

1. bootstrap and parsing;
2. monitor resilience and message lifecycle;
3. media ingestion and cleanup;
4. Zulip client endpoint coverage;
5. channel actions and registered tools;
6. advanced orchestration and operator-facing documentation.

This keeps upstream ideas mapped onto existing local modules instead of introducing a parallel implementation.

## Feature Batches

### Batch 1: Bootstrap and Parsing

- Add env-file loading from `~/.openclaw/secrets/zulip.env` with env vars still taking precedence.
- Fix stream-target parsing in `src/zulip/send.ts` so topics containing `:`, `/`, or `#` survive correctly.

### Batch 2: Monitor Resilience and Lifecycle

- Add durable processed-message state on disk to prevent duplicate handling across restarts.
- Add cross-stream topic move support by tracking `orig_stream_id` and `stream_id` aliases.
- Add structured milestone trace logging for message lifecycle debugging.
- Add config gates for mutation actions like `channel-create`, `channel-edit`, and `channel-delete`.
- Extend tool progress rendering with grouped timestamps and tool-type summaries.
- Preserve existing shutdown grace behavior and integrate new state writes into that lifecycle.

### Batch 3: Media Handling

- Add HEIC/HEIF detection and conversion to JPEG for inbound media.
- Add TTL-based cleanup for temp media directories.

### Batch 4: Zulip API Coverage

Extend `src/zulip/client.ts` and adjacent adapters with the missing endpoint families:

- message edit history;
- saved snippets CRUD;
- reminders;
- invitations;
- code playgrounds;
- default streams list/add/remove;
- admin user create/update;
- profile field create/update/delete/reorder;
- realm presence and own presence updates;
- message forwarding;
- DM conversation search filters;
- mark-all-read;
- markdown preview rendering;
- profile data updates.

### Batch 5: Actions and Tools

- Expose the new client capabilities through the existing action adapter where they fit the OpenClaw action model.
- Add or extend registered tools for operator-oriented features such as typing, snippets, reminders, invitations, default streams, playgrounds, and presence management.
- Keep compatibility with the current `zulipMessageActions` contract instead of shifting fully to a tool-only model.

### Batch 6: Advanced Orchestration

- Add multi-bot conversation support through `allowBotIds`, chain tracking, and loop prevention.
- Add sub-agent relay support where it improves status and continuity for multi-agent runs.
- Add per-channel history tracking where it meaningfully improves context.
- Add thread context fetching for recent topic messages before dispatch.
- Add optional persona routing sourced from operator-managed persona files.

### Batch 7: Documentation

- Add `SKILL.md` describing practical usage, configuration, and operator workflows.
- Document new config keys and parity-driven capabilities in `README.md`.

## Data and Config Changes

New config areas are expected in `src/types.ts` and `src/config-schema.ts` for:

- env-assisted bootstrap behavior;
- action gating;
- multi-bot allowlists and loop limits;
- persona routing;
- thread-context fetch limits;
- media cleanup retention;
- processed-message persistence.

Config additions should be optional and default-safe.

## Error Handling

- New client endpoints follow the existing request/retry patterns and typed error flow.
- Features with privileged operations must fail clearly when disabled or when Zulip rejects permissions.
- Optional integrations such as env-file loading, media cleanup, persona files, and sub-agent relay must degrade gracefully.
- Loop-prevention logic for multi-bot support must prefer safe refusal over continued chaining.

## Testing Strategy

Every batch expands tests alongside implementation.

Priority test areas:
- parser regressions for stream/topic targets;
- processed-message persistence across restart-like flows;
- cross-stream topic aliasing;
- mutation gating behavior;
- HEIC conversion and temp cleanup;
- each new client endpoint family with request-shape assertions;
- multi-bot loop prevention and allowlist behavior;
- thread-context assembly and persona routing.

The repo should remain stronger than any upstream on regression coverage.

## Rollout Strategy

Implement in batches, with verification after each batch. The order is:

1. bugfixes and bootstrap;
2. resilience state;
3. API expansion;
4. tools/actions exposure;
5. advanced orchestration;
6. docs and cleanup.

This order delivers visible parity early while containing risk.

## Decision

`openclaw-zulip-plus` stays the canonical implementation. We pursue full parity by absorbing the missing upstream capabilities into the current architecture, in batches, with tests added as features land.
