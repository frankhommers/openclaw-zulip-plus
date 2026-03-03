# Design: Dynamic Stream Discovery via `{subscribed}` Token

**Date:** 2026-03-02
**Status:** Approved

## Problem

The plugin requires a static `streams` allowlist in config. When a bot is added to a new Zulip channel, the operator must manually update the config and restart the gateway. The Zulip API provides subscription events that make automatic discovery possible.

## Solution

Add a `{subscribed}` token to the existing `streams` config array. When present, the monitor fetches the bot's current subscriptions at startup and dynamically tracks subscription changes at runtime.

## Config

```yaml
channels:
  zulip:
    # Option A: follow all subscribed channels (dynamic)
    streams: ["{subscribed}"]

    # Option B: hard allowlist (current behavior, unchanged)
    streams: ["general", "engineering"]
```

- `{subscribed}` is exclusive: if present, other entries in the array are ignored.
- If `streams` is empty or omitted, the monitor throws (current behavior preserved).

## Architecture

### Current flow

```
config.streams -> buildQueuePlan -> 1 event queue per stream -> pollStreamQueue
```

### New flow when `{subscribed}` is active

```
startup
  +-- GET /users/me/subscriptions -> list of stream names
  +-- buildQueuePlan(streams) -> 1 event queue per stream (same as now)
  +-- register separate event queue with event_types: ["subscription"]
  +-- Promise.all([...pollStreamQueue loops, subscriptionWatcher])

subscriptionWatcher:
  subscription op:add  -> start new pollStreamQueue for that channel
  subscription op:remove -> abort + cleanup existing pollStreamQueue
```

### Poll loop management

Each stream poll loop gets its own `AbortController`. A `Map<string, AbortController>` tracks active loops. The subscription watcher starts/stops entries in this map.

## Changes per file

| File | Change |
|---|---|
| `src/types.ts` | Add `SUBSCRIBED_TOKEN = "{subscribed}"` constant |
| `src/zulip/accounts.ts` | `normalizeStreamAllowlist` passes `{subscribed}` through without stripping |
| `src/zulip/monitor.ts` | Detect token, fetch subscriptions at start, subscription watcher loop, dynamic poll loop start/stop, adjust startup validation |
| `src/config-schema.ts` | No change (already accepts any string) |
| `src/zulip/queue-plan.ts` | No change (receives resolved stream names) |
| `src/zulip/client.ts` | No change (`fetchZulipSubscriptions` already exists) |
| Tests | New tests for subscription watcher, dynamic start/stop, `{subscribed}` parsing |

## Monitor detail

The `run()` function becomes:

1. Check if `{subscribed}` is in `account.streams`.
2. If yes: `activeStreams = await fetchZulipSubscriptions()` mapped to names.
3. If no: `activeStreams = account.streams` (current behavior).
4. `plan = buildQueuePlan(activeStreams)`.
5. `pollLoops = new Map<string, AbortController>()`.
6. Start a poll loop per stream, each with its own AbortController.
7. If `{subscribed}`: register a separate event queue with `event_types: ["subscription"]` and run a watcher loop:
   - `subscription op:add`: add stream to activeStreams, start new pollStreamQueue, log.
   - `subscription op:remove`: abort controller for that stream, remove from map, log.
8. On shutdown: abort all controllers including subscription watcher.

## Edge cases

- **Bot removed from channel while polling**: subscription watcher receives `op: remove`, aborts the poll loop. The poll loop may also get a Zulip error (queue invalidated) which triggers its own cleanup.
- **Race at startup**: subscriptions are fetched before poll loops start. No race.
- **Channel renamed**: existing `update_message` event handling and topic rename tracking already operates on stream IDs, not names.
- **Subscription watcher queue dies**: same reconnect/backoff logic as stream poll queues.
- **Bot added to channel it was already monitoring** (e.g. re-subscribe): check if poll loop already exists in map before starting a new one.

## Not in scope

- `{public}` token (all public channels) -- can be added later.
- Mixing `{subscribed}` with hard names -- `{subscribed}` is exclusive.
- Config hot-reload -- only subscription watcher is dynamic; other config changes require restart.
