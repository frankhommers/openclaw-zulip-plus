# Feature Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring `openclaw-zulip-plus` to full parity with the combined upstream Zulip plugin features while preserving the current architecture, resilience model, and test quality.

**Architecture:** Keep the current repo as the canonical implementation and add missing features into the existing layers: bootstrap, monitor lifecycle, uploads/media, Zulip client endpoints, action adapters, registered tools, and orchestration helpers. Implement in small TDD-driven batches so each feature family lands with targeted tests and does not weaken the current plugin behavior.

**Tech Stack:** TypeScript, Vitest, Node.js fs/path APIs, OpenClaw plugin SDK, Zulip REST API

---

### Task 1: Add env loader bootstrap support

**Files:**
- Modify: `index.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add a test in `src/channel.test.ts` that stubs `existsSync` and `readFileSync`, registers the plugin, and asserts the first existing env file is loaded without overriding pre-existing `process.env` values.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL because `index.ts` does not read `~/.openclaw/secrets/zulip.env`.

**Step 3: Write minimal implementation**

Add a small `loadZulipEnv()` helper in `index.ts` that checks:
- `~/.openclaw/secrets/zulip.env`
- `~/.openclaw/zulip.env`

Parse `KEY=VALUE` lines, ignore blanks/comments, and only populate `process.env` when the variable is currently unset.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 2: Fix stream target parsing with topic separators

**Files:**
- Modify: `src/zulip/send.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests covering targets like:
- `stream:ops#deploy:10:30`
- `stream:ops/releases`
- `#ops:topic/with/slash`

Assert that stream name is parsed once and the rest remains in topic.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL because regex split truncates topics.

**Step 3: Write minimal implementation**

Replace regex `split(/[:#/]/)` logic in `src/zulip/send.ts` with first-separator `indexOf`/slice logic matching the safer upstream behavior.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 3: Add durable processed-message watermark state

**Files:**
- Create: `src/zulip/processed-message-state.ts`
- Modify: `src/zulip/monitor.ts`
- Test: `src/zulip/monitor.recovery.test.ts`
- Test: `src/zulip/monitor.already-handled.test.ts`

**Step 1: Write the failing test**

Add a monitor-level test that simulates a processed message, reloads monitor state, and asserts the same message is skipped based on persisted watermark state rather than only in-memory dedupe.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/monitor.recovery.test.ts src/zulip/monitor.already-handled.test.ts`
Expected: FAIL because no durable processed-message state exists.

**Step 3: Write minimal implementation**

Create `src/zulip/processed-message-state.ts` with helpers to:
- load state from disk;
- mark a message processed per stream/account;
- check if a message is already processed;
- write state safely.

Wire it into `src/zulip/monitor.ts` so normal processing persists successful message completion and recovery/startup consults the persisted watermark before handling a message.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/monitor.recovery.test.ts src/zulip/monitor.already-handled.test.ts`
Expected: PASS.

### Task 4: Add cross-stream topic move tracking

**Files:**
- Modify: `src/zulip/monitor.ts`
- Test: `src/zulip/monitor.topic-rename.test.ts`

**Step 1: Write the failing test**

Add a test for a Zulip update event carrying `orig_stream_id`, `stream_id`, `orig_topic`, and `topic`, then assert a session continues correctly after a topic is moved across streams.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/monitor.topic-rename.test.ts`
Expected: FAIL because current aliasing is same-stream only.

**Step 3: Write minimal implementation**

Extend update-event types and alias logic in `src/zulip/monitor.ts` to:
- track composite `stream + topic` keys;
- map stream IDs to names from subscriptions;
- resolve canonical session keys across stream moves.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/monitor.topic-rename.test.ts`
Expected: PASS.

### Task 5: Gate channel mutation actions behind config

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config-schema.ts`
- Modify: `src/zulip/actions.ts`
- Test: `src/zulip/actions.test.ts`

**Step 1: Write the failing test**

Add tests asserting `channel-create`, `channel-edit`, and `channel-delete` are hidden or rejected unless explicit config enables them globally or per account.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/actions.test.ts`
Expected: FAIL because mutation actions are always available.

**Step 3: Write minimal implementation**

Add optional `actions` config in `src/types.ts` and `src/config-schema.ts`, then guard action listing/support/dispatch in `src/zulip/actions.ts`.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/actions.test.ts`
Expected: PASS.

### Task 6: Improve tool progress summaries

**Files:**
- Modify: `src/zulip/tool-progress.ts`
- Test: `src/zulip/tool-progress.test.ts`

**Step 1: Write the failing test**

Add tests for:
- tool type extraction from lines like `Todo:` and `exec:`;
- grouped timestamps rendering for multiple lines in the same minute;
- spoiler title summarizing tool types.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/tool-progress.test.ts`
Expected: FAIL because grouped timestamp and type-summary behavior is missing.

**Step 3: Write minimal implementation**

Extend `src/zulip/tool-progress.ts` with helper functions and accumulator state for tool-type counts/details and grouped timestamp rendering.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/tool-progress.test.ts`
Expected: PASS.

### Task 7: Add HEIC/HEIF inbound conversion

**Files:**
- Modify: `src/zulip/uploads.ts`
- Test: `src/zulip/uploads.test.ts`

**Step 1: Write the failing test**

Add tests covering HEIC/HEIF detection on inbound uploads and asserting the pipeline converts or normalizes them to JPEG output before dispatch payload assembly.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/uploads.test.ts`
Expected: FAIL because no HEIC conversion path exists.

**Step 3: Write minimal implementation**

Add MIME/extension detection and conversion hooks in `src/zulip/uploads.ts`. Keep conversion isolated behind a helper so unsupported environments fail gracefully with a clear log path.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/uploads.test.ts`
Expected: PASS.

### Task 8: Add TTL-based media cleanup

**Files:**
- Create: `src/zulip/media-sweep.ts`
- Modify: `src/zulip/uploads.ts`
- Test: `src/zulip/uploads.test.ts`

**Step 1: Write the failing test**

Add tests that create synthetic temp media directories with old timestamps and assert the sweep deletes expired entries while leaving fresh ones intact.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/uploads.test.ts`
Expected: FAIL because no cleanup module exists.

**Step 3: Write minimal implementation**

Create `src/zulip/media-sweep.ts` and call it from upload/download temp-directory flows with configurable retention.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/uploads.test.ts`
Expected: PASS.

### Task 9: Add message edit history endpoint and action

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/zulip/actions.ts`
- Test: `src/zulip/client.request.test.ts`
- Test: `src/zulip/actions.test.ts`

**Step 1: Write the failing test**

Add request-shape tests for `/api/v1/messages/{id}/history` and an action test proving the new action returns message history payload.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/client.request.test.ts src/zulip/actions.test.ts`
Expected: FAIL because no edit-history endpoint/action exists.

**Step 3: Write minimal implementation**

Add a typed client helper and expose it through `src/zulip/actions.ts` or a registered tool, depending on the current public surface.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/client.request.test.ts src/zulip/actions.test.ts`
Expected: PASS.

### Task 10: Add saved snippets CRUD

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/channel.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tool-registration or action-surface tests proving snippets can be listed, created, updated, and deleted.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL because no snippet feature exists.

**Step 3: Write minimal implementation**

Add the Zulip client helpers and expose them through a registered operator-facing tool in `src/channel.ts`.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 11: Add reminders management

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/channel.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests for list/create/delete reminder operations on the registered Zulip tool surface.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add reminder endpoints and tool exposure.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 12: Add invitations management

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/channel.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests for listing invites, sending invites, creating links, revoking links, revoking invites, and resending invites.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add invitation helpers and expose them via a registered tool.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 13: Add code playground and default stream management

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/channel.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests for listing/adding/removing code playgrounds and listing/adding/removing default streams.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add the new endpoints and expose them in registered tools without duplicating generic stream management code.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 14: Add admin user create/update and presence expansion

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/channel.ts`
- Modify: `src/types.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests for:
- create/update/deactivate/reactivate user operations;
- get own user;
- get realm presence;
- set own presence with `pingOnly` support.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add client endpoints and extend the user-facing registered tools/config typing accordingly.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 15: Add custom profile field writes and profile data updates

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/channel.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests for create/update/delete/reorder custom profile fields and user profile data updates.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add write endpoints for profile fields and profile data, then expose them through tools that follow existing output conventions.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 16: Add message forward, render, mark-all-read, and DM search filters

**Files:**
- Modify: `src/zulip/client.ts`
- Modify: `src/zulip/actions.ts`
- Modify: `src/channel.ts`
- Test: `src/zulip/actions.test.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add tests for:
- forwarding a message;
- rendering markdown preview;
- marking all messages read;
- DM-targeted search filters.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/actions.test.ts src/channel.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add client helpers and expose them through the most appropriate surfaces: actions for message operations, tools for operator utilities.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/actions.test.ts src/channel.test.ts`
Expected: PASS.

### Task 17: Add dedicated typing tool

**Files:**
- Modify: `src/channel.ts`
- Test: `src/channel.test.ts`

**Step 1: Write the failing test**

Add a test asserting a dedicated typing-oriented Zulip tool is registered and dispatches to the existing typing client helper.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel.test.ts`
Expected: FAIL because typing is internal-only today.

**Step 3: Write minimal implementation**

Register a dedicated typing tool in `src/channel.ts` that wraps the existing typing helper with validated parameters.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel.test.ts`
Expected: PASS.

### Task 18: Add per-channel history tracking and thread context fetching

**Files:**
- Modify: `src/zulip/monitor.ts`
- Test: `src/zulip/monitor.recovery.test.ts`
- Test: `src/zulip/monitor.wait-for-idle-timeout.test.ts`

**Step 1: Write the failing test**

Add tests that assert recent stream/topic messages are fetched and assembled into dispatch context, and that bounded history is maintained per channel.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/monitor.recovery.test.ts src/zulip/monitor.wait-for-idle-timeout.test.ts`
Expected: FAIL because no thread-context/history system exists.

**Step 3: Write minimal implementation**

Add a bounded history map in `src/zulip/monitor.ts`, fetch recent messages when dispatch context needs thread history, and avoid unbounded retention.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/monitor.recovery.test.ts src/zulip/monitor.wait-for-idle-timeout.test.ts`
Expected: PASS.

### Task 19: Add multi-bot support with loop prevention

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config-schema.ts`
- Modify: `src/zulip/monitor.ts`
- Test: `src/zulip/monitor.already-handled.test.ts`

**Step 1: Write the failing test**

Add tests that assert:
- non-whitelisted bot messages are ignored;
- whitelisted bot messages are accepted;
- chain length and cooldown stop recursive bot loops.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/monitor.already-handled.test.ts`
Expected: FAIL because all bot messages are currently ignored and no chain tracking exists.

**Step 3: Write minimal implementation**

Add `allowBotIds`, chain metadata tracking, and loop-prevention rules in `src/zulip/monitor.ts` plus config typing/schema support.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/monitor.already-handled.test.ts`
Expected: PASS.

### Task 20: Add sub-agent relay hooks

**Files:**
- Create: `src/agents/subagent-relay.ts`
- Modify: `src/zulip/monitor.ts`
- Test: `src/zulip/monitor.keepalive-shutdown.test.ts`

**Step 1: Write the failing test**

Add tests covering relay registration/update calls for a main message run so model/status updates can be correlated during multi-agent work.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/monitor.keepalive-shutdown.test.ts`
Expected: FAIL because no relay module exists.

**Step 3: Write minimal implementation**

Create a focused relay helper with registration/update lookup functions, then integrate it in the monitor without coupling it to message transport internals.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/monitor.keepalive-shutdown.test.ts`
Expected: PASS.

### Task 21: Add persona routing

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config-schema.ts`
- Modify: `src/zulip/monitor.ts`
- Test: `src/zulip/monitor.recovery.test.ts`

**Step 1: Write the failing test**

Add tests proving stream-based persona config injects persona content into dispatch context before the main user message content.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/zulip/monitor.recovery.test.ts`
Expected: FAIL because no persona routing exists.

**Step 3: Write minimal implementation**

Add optional persona-file config and a small loader in `src/zulip/monitor.ts` that resolves a persona prompt for matching streams/topics without blocking normal operation when files are absent.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/zulip/monitor.recovery.test.ts`
Expected: PASS.

### Task 22: Add SKILL.md and README updates

**Files:**
- Create: `SKILL.md`
- Modify: `README.md`
- Test: none

**Step 1: Write the documentation changes**

Document:
- env bootstrap support;
- new config keys;
- new tools/actions;
- multi-bot and persona options;
- parity-oriented advanced capabilities.

**Step 2: Review for consistency**

Check that names in docs match the implemented config and tool names exactly.

**Step 3: Verify markdown quality**

Run: `pnpm prettier --check README.md SKILL.md docs/plans/2026-03-17-feature-parity-design.md docs/plans/2026-03-17-feature-parity-implementation.md`
Expected: PASS or targeted formatting differences only.

### Task 23: Full verification sweep

**Files:**
- Modify: only if verification finds breakage
- Test: entire relevant suite

**Step 1: Run targeted test batches**

Run:
- `pnpm vitest run src/channel.test.ts`
- `pnpm vitest run src/zulip/actions.test.ts`
- `pnpm vitest run src/zulip/client.request.test.ts`
- `pnpm vitest run src/zulip/uploads.test.ts`
- `pnpm vitest run src/zulip/tool-progress.test.ts`
- `pnpm vitest run src/zulip/monitor.*.test.ts`

Expected: PASS.

**Step 2: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS.

**Step 3: Run build verification**

Run: `pnpm build`
Expected: PASS.

**Step 4: Prepare commits in logical batches**

Suggested commit sequence:
- `feat: load Zulip env files and fix stream target parsing`
- `feat: add durable Zulip processed-message state`
- `feat: expand Zulip client parity endpoints`
- `feat: add Zulip multi-bot and persona support`
- `docs: document parity features and operator workflows`
