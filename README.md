# openclaw-zulip-plus

Zulip channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — stream monitoring, DM support, reaction workflows, interactive actions, and crash recovery.

This plugin is a merge of the best features from multiple independent Zulip implementations.

## Features

### Core Messaging
- Long-poll event queue monitoring with automatic reconnection
- Stream and direct message (DM) support
- Send, edit, delete messages
- Text chunking for long replies
- Backtick sanitization and markdown table conversion
- Typing indicators

### Reactions & Interactive
- Emoji reaction indicators (processing, success, failure)
- Multi-stage reaction workflow state machine (7 stages)
- Interactive numbered reaction buttons with session management
- Generic reaction callbacks

### Resilience
- Exponential backoff with jitter on transient errors
- In-flight checkpoint persistence (crash recovery)
- Message deduplication
- Freshness checker (detect missed events)
- Concurrency-limited message handlers
- Graceful shutdown with delivery grace period
- Topic rename tracking with chain resolution

### Actions API (13+ action types)
- `send` — stream and DM messages with media
- `read` — fetch messages from a stream/topic
- `edit` / `delete` — modify or remove messages
- `react` — add/remove emoji reactions
- `search` — full-text search across messages
- `pin` / `unpin` — star/unstar messages
- `channel-list` / `channel-create` / `channel-edit` / `channel-delete` — stream CRUD
- `member-info` — user info lookup
- `sendWithReactions` — send with interactive reaction buttons

### Access Control
- DM policies: `open`, `pairing`, `allowlist`, `disabled`
- Group/stream policies with sender allowlists
- Admin action gating
- Chat modes: `oncall`, `onmessage`, `onchar` (prefix triggers)

### Advanced
- Tool progress accumulation (batched tool-call messages)
- Block streaming toggle
- Multi-account support with per-account config
- Onboarding wizard with probe validation
- SSRF-safe credential probing
- Configurable via Zod-validated schemas

## Installation

### From GitHub (clone + local install)

```bash
git clone https://github.com/frankhommers/openclaw-zulip-plus.git
openclaw plugins install ./openclaw-zulip-plus
```

### From npm (once published)

```bash
openclaw plugins install openclaw-zulip-plus
```

### From a local directory

```bash
openclaw plugins install /path/to/openclaw-zulip-plus
```

> **Note:** `openclaw plugins install` does not support `github:` specs directly.
> Clone the repository first, then install from the local path.

## Configuration

Configure via `openclaw config set` or directly in your OpenClaw config file:

```yaml
zulip:
  url: https://your-org.zulipchat.com
  email: bot@your-org.zulipchat.com
  apiKey: your-api-key
  streams:
    - general
  chatmode: onmessage     # oncall | onmessage | onchar
  dmPolicy: disabled       # open | pairing | allowlist | disabled
  reactions:
    enabled: true
    onStart: eyes
    onSuccess: check_mark
    onFailure: cross_mark
```

## Development

```bash
git clone https://github.com/frankhommers/openclaw-zulip-plus.git
cd openclaw-zulip-plus
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (110 tests)
```

## Credits

This plugin merges work from multiple independent Zulip/OpenClaw implementations. Credit to all original authors:

| Repository | Author | Key Contributions |
|---|---|---|
| [jamie-dit/zulipclaw](https://github.com/jamie-dit/zulipclaw) | Jamie Le | Reaction workflow state machine, in-flight checkpoints, topic rename tracking, tool progress accumulator, concurrency limits, keepalive messages, reaction buttons, 63+ tests. Used as the base for the merge. |
| [FtlC-ian/openclaw-channel-zulip](https://github.com/FtlC-ian/openclaw-channel-zulip) | Debbie (FtlC-ian) | Typed Zulip SDK client (30+ API wrappers), 13+ action types, DM policies, chat modes, group/stream policies, admin action gating, block streaming, SSRF-safe probe, onboarding wizard. |
| [rafaelreis-r/openclaw-zulip](https://github.com/rafaelreis-r/openclaw-zulip) | Rafael Reis | Standalone plugin extraction from jamie-dit's monorepo, initial packaging for npm distribution. |
| [tasshin/zulip-openclaw](https://github.com/tasshin/zulip-openclaw) | Tasshin Fogleman, Ember | Independent JavaScript implementation, persona/agent routing, context injection. Reviewed during audit. |
| [tobiaswaggoner/openclaw-plugin-zulip](https://github.com/tobiaswaggoner/openclaw-plugin-zulip) | Tobias Waggoner | Independent TypeScript implementation, DM policy patterns. Reviewed during audit. |
| [xy-host/openclaw-zulip-plugin](https://github.com/xy-host/openclaw-zulip-plugin) | xy-host | Independent implementation, agent skill file patterns, block streaming approach. Reviewed during audit. |

Built on top of the [OpenClaw](https://github.com/openclaw/openclaw) platform.

## License

MIT
