# openclaw-zulip-plus

Use this plugin when OpenClaw needs first-class Zulip support for streams, DMs, admin workflows, and long-running monitored conversations.

## What It Does

- Monitors Zulip streams and DMs with restart-safe recovery
- Sends messages, files, reactions, typing, reminders, snippets, invites, and admin operations
- Preserves topic continuity across renames and stream moves
- Supports multi-account routing, persona injection, and optional bot-to-bot chains

## Operator Notes

- Bootstrap env files are loaded from `~/.openclaw/secrets/zulip.env` and then `~/.openclaw/zulip.env`
- `defaultAccount` selects which Zulip account OpenClaw should use by default
- `actions.channel-create`, `actions.channel-edit`, and `actions.channel-delete` are opt-in
- `personaRouting` can prepend a persona file for matching `stream` / `topic`
- `allowBotIds` and `botLoopPrevention` allow controlled bot-to-bot flows without infinite loops

## Main Tools

- `zulip_send`, `zulip_typing`, `zulip_messages`, `zulip_streams`, `zulip_topics`
- `zulip_users`, `zulip_server_settings`, `zulip_stream_settings`, `zulip_default_streams`
- `zulip_reminders`, `zulip_saved_snippets`, `zulip_invitations`, `zulip_code_playgrounds`
- `zulip_upload`, `zulip_attachments`, `zulip_alert_words`, `zulip_user_preferences`

## Recommended Config Shape

```yaml
zulip:
  defaultAccount: default
  streams:
    - "{subscribed}"
  actions:
    channel-create: false
    channel-edit: false
    channel-delete: false
  allowBotIds: []
  botLoopPrevention:
    maxChainLength: 3
    cooldownMs: 30000
  personaRouting: []
```

## Good Defaults

- Use `"{subscribed}"` when the bot should follow whatever Zulip subscriptions already exist
- Keep channel mutation actions disabled unless the bot should manage streams
- Use persona files only for clearly scoped workflows like `incidents` or `deployments`
- Use `allowBotIds` only for known orchestrator/specialist bot setups
