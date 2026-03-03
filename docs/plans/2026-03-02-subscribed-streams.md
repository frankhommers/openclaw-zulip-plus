# `{subscribed}` Dynamic Stream Discovery — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the Zulip plugin to automatically monitor all channels the bot is subscribed to, with dynamic add/remove at runtime, via a `{subscribed}` token in the `streams` config array.

**Architecture:** The `streams` config accepts a special `{subscribed}` token. When present, the monitor fetches subscriptions at startup via `GET /users/me/subscriptions`, then runs a subscription watcher event queue alongside the per-stream poll loops. The watcher dynamically starts/stops poll loops as the bot is added to or removed from channels. When `{subscribed}` is absent, existing hard-allowlist behavior is unchanged.

**Tech Stack:** TypeScript, Vitest, Zulip REST API (`/users/me/subscriptions`, `/api/v1/register` with `event_types: ["subscription"]`)

---

## Task 1: Add `SUBSCRIBED_TOKEN` constant and `isSubscribedMode` helper

**Files:**
- Modify: `src/types.ts`

**Step 1: Add the constant and helper at the end of `src/types.ts`**

```typescript
/** Magic token for dynamic stream discovery via bot subscriptions. */
export const SUBSCRIBED_TOKEN = "{subscribed}";

/** Returns true if the streams array contains the `{subscribed}` token. */
export function isSubscribedMode(streams: string[]): boolean {
  return streams.some((s) => s.trim() === SUBSCRIBED_TOKEN);
}
```

**Step 2: Write tests in a new file `src/types.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { isSubscribedMode, SUBSCRIBED_TOKEN } from "../types.js";

describe("SUBSCRIBED_TOKEN", () => {
  it("equals {subscribed}", () => {
    expect(SUBSCRIBED_TOKEN).toBe("{subscribed}");
  });
});

describe("isSubscribedMode", () => {
  it("returns true when token is present", () => {
    expect(isSubscribedMode(["{subscribed}"])).toBe(true);
  });

  it("returns true when token is present among others", () => {
    expect(isSubscribedMode(["general", "{subscribed}", "ops"])).toBe(true);
  });

  it("returns false for a normal allowlist", () => {
    expect(isSubscribedMode(["general", "ops"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(isSubscribedMode([])).toBe(false);
  });

  it("handles whitespace around token", () => {
    expect(isSubscribedMode(["  {subscribed}  "])).toBe(true);
  });
});
```

**Step 3: Run tests to verify they pass**

Run: `npx vitest run src/types.test.ts`
Expected: 5 tests PASS

**Step 4: Commit**

```
feat: add SUBSCRIBED_TOKEN constant and isSubscribedMode helper
```

---

## Task 2: Update `normalizeStreamAllowlist` to preserve `{subscribed}`

**Files:**
- Modify: `src/zulip/accounts.ts:167-170`

**Step 1: Write a test in a new file `src/zulip/accounts.test.ts`**

We cannot directly test the private `normalizeStreamAllowlist` function, but we can test through `resolveZulipAccount`. However, that requires complex mocking. Instead, extract the function or test the behavior end-to-end.

Simpler approach: the `normalizeStreamName` function strips `#` prefixes. `{subscribed}` does not start with `#`, so it would survive `normalizeStreamName`. But `normalizeStreamName` returns `""` for empty strings and trims whitespace. Let's verify `{subscribed}` passes through correctly.

Actually, `normalizeStreamName("{subscribed}")` returns `"{subscribed}"` (no `#` to strip, non-empty). So the current code already preserves it. But we should add a guard: `normalizeStreamAllowlist` should recognize and preserve the token as-is without running it through `normalizeStreamName` (which could theoretically strip a leading `#` if the token format ever changes).

**Update `normalizeStreamAllowlist` in `src/zulip/accounts.ts:167-170`:**

```typescript
import { SUBSCRIBED_TOKEN } from "../types.js";

function normalizeStreamAllowlist(streams?: string[]): string[] {
  const result: string[] = [];
  for (const entry of streams ?? []) {
    const trimmed = entry.trim();
    if (trimmed === SUBSCRIBED_TOKEN) {
      // Return immediately — {subscribed} is exclusive, other entries are ignored.
      return [SUBSCRIBED_TOKEN];
    }
    const normalized = normalizeStreamName(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return Array.from(new Set(result));
}
```

**Step 2: Add a test to `src/zulip/queue-plan.test.ts` to verify `{subscribed}` is excluded from queue plan building (it should never reach `buildZulipQueuePlan`)**

```typescript
it("does not include {subscribed} as a stream name", () => {
  // {subscribed} should be resolved before reaching buildZulipQueuePlan,
  // but if it leaks through, it should be treated as a regular entry (not crash).
  const plan = buildZulipQueuePlan(["{subscribed}"]);
  expect(plan).toEqual([{ stream: "{subscribed}" }]);
});
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All existing tests pass + new test passes

**Step 4: Commit**

```
feat: normalizeStreamAllowlist treats {subscribed} as exclusive token
```

---

## Task 3: Update monitor startup validation to accept `{subscribed}`

**Files:**
- Modify: `src/zulip/monitor.ts:1119-1123` and `src/zulip/monitor.ts:2398-2406`

The current code throws if `account.streams.length === 0`. With `{subscribed}`, the streams array will be `["{subscribed}"]` which has length 1, so the existing validation passes. However, the code at line 2400 passes `account.streams` (which now contains `["{subscribed}"]`) to `buildZulipQueuePlan`. We need to intercept this.

**Step 1: Add import of `isSubscribedMode` and `SUBSCRIBED_TOKEN` at top of `monitor.ts`**

Add to the imports at the top of `src/zulip/monitor.ts`:

```typescript
import { isSubscribedMode, SUBSCRIBED_TOKEN } from "../types.js";
```

**Step 2: Add `fetchBotSubscriptions` helper function in `monitor.ts`**

Add after the existing `fetchZulipMe` function (around line 536):

```typescript
/**
 * Fetch the bot's current channel subscriptions and return stream names.
 */
async function fetchBotSubscriptions(params: {
  auth: ZulipAuth;
  abortSignal?: AbortSignal;
}): Promise<string[]> {
  const res = await zulipRequest<{
    result: string;
    msg?: string;
    subscriptions?: Array<{ name?: string }>;
  }>({
    auth: params.auth,
    method: "GET",
    path: "/api/v1/users/me/subscriptions",
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success") {
    throw new Error(res.msg || "Failed to fetch Zulip subscriptions");
  }
  return (res.subscriptions ?? [])
    .map((sub) => sub.name?.trim())
    .filter((name): name is string => Boolean(name));
}
```

**Step 3: Add `registerSubscriptionQueue` helper function in `monitor.ts`**

Add after `fetchBotSubscriptions`:

```typescript
/**
 * Register an event queue that receives subscription add/remove events.
 */
async function registerSubscriptionQueue(params: {
  auth: ZulipAuth;
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const res = await zulipRequest<{
    result: string;
    msg?: string;
    queue_id?: string;
    last_event_id?: number;
  }>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form: {
      event_types: JSON.stringify(["subscription"]),
      apply_markdown: "false",
    },
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip subscription event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(`[zulip] registered subscription watcher queue ${res.queue_id}`);
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}
```

**Step 4: Commit (preparation functions)**

```
feat: add fetchBotSubscriptions and registerSubscriptionQueue helpers
```

---

## Task 4: Implement the subscription watcher and dynamic poll loop management

This is the core task. Modify the `run()` function inside `monitorZulipProvider` to:
1. Detect `{subscribed}` mode
2. Resolve initial streams from subscriptions
3. Track active poll loops in a `Map<string, AbortController>`
4. Run a subscription watcher loop alongside poll loops

**Files:**
- Modify: `src/zulip/monitor.ts` — the `run()` closure (lines 1135-2407)

**Step 1: Replace the tail of `run()` (lines 2398-2406) with the new dynamic logic**

Replace:
```typescript
    await replayPendingCheckpoints();

    const plan = buildZulipQueuePlan(account.streams);
    if (plan.length === 0) {
      throw new Error(
        `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
      );
    }
    await Promise.all(plan.map((entry) => pollStreamQueue(entry.stream)));
  };
```

With:
```typescript
    await replayPendingCheckpoints();

    // Resolve the effective stream list.
    const subscriptionMode = isSubscribedMode(account.streams);
    let effectiveStreams: string[];

    if (subscriptionMode) {
      logger.info(
        `[zulip:${account.accountId}] {subscribed} mode: fetching bot subscriptions...`,
      );
      effectiveStreams = await fetchBotSubscriptions({ auth, abortSignal });
      logger.info(
        `[zulip:${account.accountId}] {subscribed} mode: monitoring ${effectiveStreams.length} channel(s): ${effectiveStreams.join(", ") || "(none)"}`,
      );
      if (effectiveStreams.length === 0) {
        logger.warn(
          `[zulip:${account.accountId}] {subscribed} mode: bot is not subscribed to any channels — waiting for subscription events...`,
        );
      }
    } else {
      effectiveStreams = account.streams;
    }

    const plan = buildZulipQueuePlan(effectiveStreams);

    // For {subscribed} mode we don't throw on empty plan — the watcher will
    // start poll loops when the bot gets subscribed to channels.
    if (!subscriptionMode && plan.length === 0) {
      throw new Error(
        `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
      );
    }

    // Track active poll loops so we can dynamically start/stop them.
    const activePollControllers = new Map<string, AbortController>();

    const startStreamPoll = (stream: string) => {
      if (activePollControllers.has(stream)) {
        return; // Already monitoring this stream.
      }
      const streamAbort = new AbortController();
      activePollControllers.set(stream, streamAbort);

      // Link to parent abort so global shutdown stops this loop.
      const onParentAbort = () => streamAbort.abort();
      abortSignal.addEventListener("abort", onParentAbort, { once: true });

      pollStreamQueue(stream)
        .catch((err) => {
          if (!stopped && !abortSignal.aborted) {
            runtime.error?.(
              `[zulip:${account.accountId}] poll loop crashed for stream "${stream}": ${String(err)}`,
            );
          }
        })
        .finally(() => {
          activePollControllers.delete(stream);
          abortSignal.removeEventListener("abort", onParentAbort);
        });
    };

    const stopStreamPoll = (stream: string) => {
      const controller = activePollControllers.get(stream);
      if (controller) {
        controller.abort();
        activePollControllers.delete(stream);
        logger.info(`[zulip:${account.accountId}] stopped monitoring stream: ${stream}`);
      }
    };

    // Start initial poll loops.
    for (const entry of plan) {
      startStreamPoll(entry.stream);
    }

    if (subscriptionMode) {
      // Run the subscription watcher loop.
      const watchSubscriptions = async () => {
        let subRetry = 0;
        while (!stopped && !abortSignal.aborted) {
          let subQueueId = "";
          let subLastEventId = -1;

          try {
            const reg = await registerSubscriptionQueue({ auth, abortSignal });
            subQueueId = reg.queueId;
            subLastEventId = reg.lastEventId;
            subRetry = 0;

            while (!stopped && !abortSignal.aborted) {
              const events = await pollEvents({
                auth,
                queueId: subQueueId,
                lastEventId: subLastEventId,
                abortSignal,
              });
              if (events.result !== "success") {
                throw new Error(events.msg || "Subscription poll failed");
              }

              for (const evt of events.events ?? []) {
                if (typeof evt.id === "number" && evt.id > subLastEventId) {
                  subLastEventId = evt.id;
                }

                if (evt.type === "subscription" && evt.op === "add") {
                  for (const sub of evt.subscriptions ?? []) {
                    const name = normalizeStreamName(sub.name);
                    if (name && !activePollControllers.has(name)) {
                      logger.info(
                        `[zulip:${account.accountId}] {subscribed} new channel: ${name}`,
                      );
                      startStreamPoll(name);
                    }
                  }
                } else if (evt.type === "subscription" && evt.op === "remove") {
                  for (const sub of evt.subscriptions ?? []) {
                    const name = normalizeStreamName(sub.name);
                    if (name && activePollControllers.has(name)) {
                      logger.info(
                        `[zulip:${account.accountId}] {subscribed} removed from channel: ${name}`,
                      );
                      stopStreamPoll(name);
                    }
                  }
                }
              }

              // Throttle on empty events (heartbeats).
              const actionEvents = (events.events ?? []).filter(
                (e) => e.type === "subscription",
              );
              if (actionEvents.length === 0) {
                await sleep(2000, abortSignal).catch(() => undefined);
              }
            }
          } catch (err) {
            if (stopped || abortSignal.aborted) {
              break;
            }
            subQueueId = "";
            subRetry += 1;
            const backoffMs = computeZulipMonitorBackoffMs({
              attempt: subRetry,
              status: undefined,
            });
            logger.warn(
              `[zulip:${account.accountId}] subscription watcher error (attempt=${subRetry}): ${String(err)} (retry in ${backoffMs}ms)`,
            );
            await sleep(backoffMs, abortSignal).catch(() => undefined);
          } finally {
            // Best-effort cleanup of subscription queue.
            if (subQueueId) {
              try {
                await zulipRequest({
                  auth,
                  method: "DELETE",
                  path: "/api/v1/events",
                  form: { queue_id: subQueueId },
                });
              } catch {
                // Best effort.
              }
            }
          }
        }
      };

      // Run subscription watcher alongside existing poll loops.
      // The watcher runs until stopped; poll loops are managed dynamically.
      await watchSubscriptions();
    } else {
      // Static mode: wait for all poll loops to complete (existing behavior).
      await Promise.all(
        Array.from(activePollControllers.values()).map(
          () => new Promise<void>(() => {}), // poll loops run until aborted
        ),
      );
      // Actually, the old code was:
      //   await Promise.all(plan.map((entry) => pollStreamQueue(entry.stream)));
      // which blocks until all poll loops finish. Since we now fire-and-forget
      // via startStreamPoll, we need to wait differently. The simplest approach
      // is to keep the original code path for static mode.
    }
  };
```

**Wait — this is getting complex.** The cleaner approach for static mode is to keep using `Promise.all` with the direct `pollStreamQueue` calls. Let's refactor:

**Revised Step 1:** Only introduce the `activePollControllers` map and `startStreamPoll`/`stopStreamPoll` when in subscription mode. For static mode, keep the original `Promise.all` call.

Replace lines 2398-2406:
```typescript
    await replayPendingCheckpoints();

    const subscriptionMode = isSubscribedMode(account.streams);

    if (!subscriptionMode) {
      // ── Static allowlist mode (unchanged behavior) ──
      const plan = buildZulipQueuePlan(account.streams);
      if (plan.length === 0) {
        throw new Error(
          `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
        );
      }
      await Promise.all(plan.map((entry) => pollStreamQueue(entry.stream)));
      return;
    }

    // ── {subscribed} dynamic mode ──
    logger.info(
      `[zulip:${account.accountId}] {subscribed} mode: fetching bot subscriptions...`,
    );
    const initialStreams = await fetchBotSubscriptions({ auth, abortSignal });
    logger.info(
      `[zulip:${account.accountId}] {subscribed} mode: monitoring ${initialStreams.length} channel(s): ${initialStreams.join(", ") || "(none)"}`,
    );

    // Track active poll loops for dynamic start/stop.
    const activePollControllers = new Map<string, AbortController>();

    const startStreamPoll = (stream: string) => {
      if (activePollControllers.has(stream)) {
        return;
      }
      const streamAbort = new AbortController();
      activePollControllers.set(stream, streamAbort);
      const onParentAbort = () => streamAbort.abort();
      abortSignal.addEventListener("abort", onParentAbort, { once: true });

      pollStreamQueue(stream)
        .catch((err) => {
          if (!stopped && !abortSignal.aborted) {
            runtime.error?.(
              `[zulip:${account.accountId}] poll loop crashed for stream "${stream}": ${String(err)}`,
            );
          }
        })
        .finally(() => {
          activePollControllers.delete(stream);
          abortSignal.removeEventListener("abort", onParentAbort);
        });
    };

    const stopStreamPoll = (stream: string) => {
      const controller = activePollControllers.get(stream);
      if (controller) {
        controller.abort();
        activePollControllers.delete(stream);
        logger.info(`[zulip:${account.accountId}] stopped monitoring stream: ${stream}`);
      }
    };

    // Start initial poll loops.
    for (const stream of initialStreams) {
      startStreamPoll(stream);
    }

    // Run subscription watcher — blocks until stopped.
    let subRetry = 0;
    while (!stopped && !abortSignal.aborted) {
      let subQueueId = "";
      let subLastEventId = -1;

      try {
        const reg = await registerSubscriptionQueue({ auth, abortSignal });
        subQueueId = reg.queueId;
        subLastEventId = reg.lastEventId;
        subRetry = 0;

        while (!stopped && !abortSignal.aborted) {
          const events = await pollEvents({
            auth,
            queueId: subQueueId,
            lastEventId: subLastEventId,
            abortSignal,
          });
          if (events.result !== "success") {
            throw new Error(events.msg || "Subscription poll failed");
          }

          for (const evt of events.events ?? []) {
            if (typeof evt.id === "number" && evt.id > subLastEventId) {
              subLastEventId = evt.id;
            }

            if (evt.type === "subscription" && evt.op === "add") {
              for (const sub of (evt as any).subscriptions ?? []) {
                const name = normalizeStreamName(sub.name);
                if (name && !activePollControllers.has(name)) {
                  logger.info(
                    `[zulip:${account.accountId}] {subscribed} new channel: ${name}`,
                  );
                  startStreamPoll(name);
                }
              }
            } else if (evt.type === "subscription" && evt.op === "remove") {
              for (const sub of (evt as any).subscriptions ?? []) {
                const name = normalizeStreamName(sub.name);
                if (name && activePollControllers.has(name)) {
                  logger.info(
                    `[zulip:${account.accountId}] {subscribed} removed from channel: ${name}`,
                  );
                  stopStreamPoll(name);
                }
              }
            }
          }

          // Throttle on empty/heartbeat events.
          const subEvents = (events.events ?? []).filter(
            (e) => e.type === "subscription",
          );
          if (subEvents.length === 0) {
            await sleep(2000, abortSignal).catch(() => undefined);
          }
        }
      } catch (err) {
        if (stopped || abortSignal.aborted) {
          break;
        }
        subQueueId = "";
        subRetry += 1;
        const backoffMs = computeZulipMonitorBackoffMs({
          attempt: subRetry,
          status: undefined,
        });
        logger.warn(
          `[zulip:${account.accountId}] subscription watcher error (attempt=${subRetry}): ${String(err)} (retry in ${backoffMs}ms)`,
        );
        await sleep(backoffMs, abortSignal).catch(() => undefined);
      } finally {
        if (subQueueId) {
          try {
            await zulipRequest({
              auth,
              method: "DELETE",
              path: "/api/v1/events",
              form: { queue_id: subQueueId },
            });
          } catch {
            // Best effort.
          }
        }
      }
    }
  };
```

**Step 2: Fix `shouldIgnoreMessage` to work in subscription mode**

In `shouldIgnoreMessage` (line 637), the check `params.streams.length > 0 && !params.streams.includes(stream)` will fail in subscription mode because `account.streams` is `["{subscribed}"]`, not the actual list. The stream poll queue already filters server-side by narrow, so this client-side check is defense-in-depth.

Two options:
- Pass the effective streams list instead of `account.streams`
- Skip the client-side check when in subscription mode (the server-side narrow is sufficient)

The simplest fix: in subscription mode, each `pollStreamQueue` is already narrowed to one stream. The client-side filter in `shouldIgnoreMessage` becomes redundant. But for safety, we should skip the allowlist check when `account.streams` contains `{subscribed}`.

Update `shouldIgnoreMessage` at line 637:

```typescript
  if (
    params.streams.length > 0 &&
    !params.streams.some((s) => s === "{subscribed}") &&
    !params.streams.includes(stream)
  ) {
    return { ignore: true, reason: "not-allowed-stream" };
  }
```

Similarly for the generic reaction filter at line 2007:

```typescript
  if (
    account.streams.length > 0 &&
    !isSubscribedMode(account.streams) &&
    !account.streams.includes(source.stream)
  ) {
    return;
  }
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All 110 existing tests pass (no behavioral change for static mode)

**Step 4: Commit**

```
feat: implement {subscribed} dynamic stream discovery in monitor

When streams config contains "{subscribed}", the monitor fetches the
bot's current channel subscriptions at startup and dynamically tracks
subscription add/remove events at runtime. New channels are picked up
without gateway restart.

Static allowlist mode (explicit stream names) is unchanged.
```

---

## Task 5: Add subscription event type definitions

**Files:**
- Modify: `src/zulip/monitor.ts` — add type definitions near the top (after existing Zulip types)

**Step 1: Add types for subscription events**

Find the existing event type definitions in `monitor.ts` and add:

```typescript
type ZulipSubscriptionEventSub = {
  stream_id?: number;
  name?: string;
};

type ZulipSubscriptionEvent = {
  id: number;
  type: "subscription";
  op: "add" | "remove" | "update" | "peer_add" | "peer_remove";
  subscriptions?: ZulipSubscriptionEventSub[];
};
```

Then update the `(evt as any).subscriptions` casts in Task 4 to use proper types:

```typescript
if (evt.type === "subscription" && evt.op === "add") {
  const subEvt = evt as unknown as ZulipSubscriptionEvent;
  for (const sub of subEvt.subscriptions ?? []) {
```

**Step 2: Commit**

```
refactor: add proper types for subscription events
```

---

## Task 6: Update `shouldIgnoreMessage` tests

**Files:**
- Check existing tests that reference `shouldIgnoreMessage` or stream filtering

The `shouldIgnoreMessage` function is tested indirectly through the monitor integration tests. The existing tests use static stream lists, so they should continue passing. Add a focused unit test:

**Step 1: If `shouldIgnoreMessage` is not exported, verify existing tests cover static mode**

Run: `npx vitest run`
Expected: All tests pass

If `shouldIgnoreMessage` is not exported (it's a local function), the existing integration tests are sufficient for static mode.

**Step 2: Commit (if any test changes were needed)**

```
test: verify shouldIgnoreMessage works with {subscribed} token
```

---

## Task 7: Update README with `{subscribed}` documentation

**Files:**
- Modify: `README.md`

**Step 1: Update the Configuration section**

Add to the `streams` documentation in the Configuration section:

```markdown
### Stream monitoring

```yaml
# Option A: Monitor specific channels (static allowlist)
streams:
  - general
  - engineering

# Option B: Automatically monitor all channels the bot is subscribed to
streams:
  - "{subscribed}"
```

With `{subscribed}`, the plugin:
- Fetches the bot's current channel subscriptions at startup
- Dynamically starts monitoring when the bot is added to a new channel
- Stops monitoring when the bot is removed from a channel
- No gateway restart needed when channels change

Note: `{subscribed}` is exclusive. When present, other stream names in the array are ignored.
```

**Step 2: Commit**

```
docs: add {subscribed} stream mode to README
```

---

## Task 8: Final verification

**Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (110 existing + new tests)

**Step 3: Commit all remaining changes and push**

```bash
git push
```
