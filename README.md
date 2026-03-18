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
- Durable processed-message state across restarts
- Message deduplication
- Freshness checker (detect missed events)
- Concurrency-limited message handlers
- Graceful shutdown with delivery grace period
- Topic rename tracking with chain resolution
- Cross-stream topic move continuity
- Bounded per-thread history and thread-context hydration

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
- `defaultAccount` routing override
- Persona routing by stream/topic with file-backed prompts
- Allowlisted multi-bot conversations with loop prevention
- Dedicated subagent relay hooks for long-running message flows
- Onboarding wizard with probe validation
- SSRF-safe credential probing
- Configurable via Zod-validated schemas

## Installation

### From GitHub (clone + local install)

```bash
git clone --recurse-submodules https://github.com/frankhommers/openclaw-zulip-plus.git
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
    # Or use "{subscribed}" to auto-follow all channels the bot is subscribed to
    # streams:
    #   - "{subscribed}"
  chatmode: onmessage # oncall | onmessage | onchar
  dmPolicy: disabled # open | pairing | allowlist | disabled
  reactions:
    enabled: true
    onStart: eyes
    onSuccess: check_mark
    onFailure: cross_mark
```

You can also bootstrap credentials from local env files without putting them in the main OpenClaw config:

- `~/.openclaw/secrets/zulip.env`
- `~/.openclaw/zulip.env`

Existing shell environment variables still win.

When `streams` includes `"{subscribed}"`, the plugin auto-discovers channels via Zulip subscriptions:

- On startup, it fetches the bot's current subscribed channels.
- During runtime, it listens for Zulip `subscription` events and starts/stops monitoring immediately.
- This mode is dynamic: adding the bot to a channel does not require config edits or gateway restarts.

### Useful Config Additions

```yaml
zulip:
  defaultAccount: ops
  actions:
    channel-create: false
    channel-edit: false
    channel-delete: false
  allowBotIds:
    - 123456
  botLoopPrevention:
    maxChainLength: 3
    cooldownMs: 30000
  personaRouting:
    - stream: marcel
      topic: incidents
      personaFile: /Users/me/.openclaw/personas/incidents.txt
```

- `defaultAccount` selects which configured Zulip account is used when no explicit account is provided.
- `actions.*` gates stream mutation actions so admin features stay opt-in.
- `allowBotIds` allows specific bot senders through the monitor.
- `botLoopPrevention` bounds bot-to-bot chains.
- `personaRouting` prepends a persona file for matching stream/topic traffic.

### Tool Surface

Root tools exposed by the plugin include:

- `zulip_send`, `zulip_typing`, `zulip_messages`, `zulip_streams`, `zulip_topics`
- `zulip_users`, `zulip_server_settings`, `zulip_stream_settings`, `zulip_default_streams`
- `zulip_reminders`, `zulip_saved_snippets`, `zulip_invitations`, `zulip_code_playgrounds`
- `zulip_upload`, `zulip_attachments`, `zulip_alert_words`, `zulip_user_preferences`

## Development

```bash
git clone --recurse-submodules https://github.com/frankhommers/openclaw-zulip-plus.git
cd openclaw-zulip-plus
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (110 tests)
```

## Credits

This plugin merges work from multiple independent Zulip/OpenClaw implementations. Credit to all original authors:

| Repository                                                                                      | Author                  | Key Contributions                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [jamie-dit/zulipclaw](https://github.com/jamie-dit/zulipclaw)                                   | Jamie Le                | Reaction workflow state machine, in-flight checkpoints, topic rename tracking, tool progress accumulator, concurrency limits, keepalive messages, reaction buttons, 63+ tests. Used as the base for the merge. |
| [FtlC-ian/openclaw-channel-zulip](https://github.com/FtlC-ian/openclaw-channel-zulip)           | Debbie (FtlC-ian)       | Typed Zulip SDK client (30+ API wrappers), 13+ action types, DM policies, chat modes, group/stream policies, admin action gating, block streaming, SSRF-safe probe, onboarding wizard.                         |
| [rafaelreis-r/openclaw-zulip](https://github.com/rafaelreis-r/openclaw-zulip)                   | Rafael Reis             | Standalone plugin extraction from jamie-dit's monorepo, initial packaging for npm distribution.                                                                                                                |
| [tasshin/zulip-openclaw](https://github.com/tasshin/zulip-openclaw)                             | Tasshin Fogleman, Ember | Independent JavaScript implementation, persona/agent routing, context injection. Reviewed during audit.                                                                                                        |
| [tobiaswaggoner/openclaw-plugin-zulip](https://github.com/tobiaswaggoner/openclaw-plugin-zulip) | Tobias Waggoner         | Independent TypeScript implementation, DM policy patterns. Reviewed during audit.                                                                                                                              |
| [xy-host/openclaw-zulip-plugin](https://github.com/xy-host/openclaw-zulip-plugin)               | xy-host                 | Independent implementation, agent skill file patterns, block streaming approach. Reviewed during audit.                                                                                                        |

All 6 upstream repos are included as git submodules in the `upstream/` directory. The pinned commit in each submodule is the last version that was reviewed/merged into this plugin. Run `git submodule status` to see the exact SHAs, or `git submodule update --remote` to pull their latest.

Built on top of the [OpenClaw](https://github.com/openclaw/openclaw) platform.

## License

MIT
