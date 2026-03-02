import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { ZulipConfigSchema } from "./config-schema.js";
import { resolveZulipGroupRequireMention } from "./group-mentions.js";
import { looksLikeZulipTargetId, normalizeZulipMessagingTarget } from "./normalize.js";
import { zulipOnboardingAdapter } from "./onboarding.js";
import { getZulipRuntime } from "./runtime.js";
import type { ZulipAccountConfig, ZulipConfig } from "./types.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { zulipMessageActions } from "./zulip/actions.js";
import { monitorZulipProvider } from "./zulip/monitor.js";
import { normalizeStreamName, normalizeTopic, normalizeZulipBaseUrl } from "./zulip/normalize.js";
import { sendZulipStreamMessage } from "./zulip/send.js";
import { parseZulipTarget } from "./zulip/targets.js";
import { resolveOutboundMedia, uploadZulipFile } from "./zulip/uploads.js";

const meta = {
  id: "zulip",
  label: "Zulip",
  selectionLabel: "Zulip (plugin)",
  detailLabel: "Zulip Bot",
  docsPath: "/channels/zulip",
  docsLabel: "zulip",
  blurb: "Zulip streams/topics with reaction-based reply indicators; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 70,
  quickstartAllowFrom: false,
} as const;

const activeProviders = new Map<string, { stop: () => void }>();

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(zulip|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${username.toLowerCase()}` : "";
  }
  return trimmed.replace(/^(zulip|user):/i, "").toLowerCase();
}

export const zulipPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  id: "zulip",
  meta: {
    ...meta,
  },
  defaults: {
    queue: {
      // Prefer one reply per message by default (avoid "collect" coalescing).
      mode: "followup",
      // Keep followups snappy; users can override via messages.queue.* config.
      debounceMs: 250,
    },
  },
  onboarding: zulipOnboardingAdapter,
  pairing: {
    idLabel: "zulipUserId",
    normalizeAllowEntry: (entry) => entry.trim(),
    notifyApproval: async () => {
      // MVP: no DMs/pairing flow yet.
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    threads: true,
    reactions: true,
    media: true,
    nativeCommands: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  groups: {
    resolveRequireMention: resolveZulipGroupRequireMention,
  },
  mentions: {
    stripPatterns: () => [
      // Zulip user mentions in raw Markdown look like: @**Full Name**
      "@\\\\*\\\\*[^*]+\\\\*\\\\*",
      // Wildcard mentions.
      "\\\\B@all\\\\b",
      "\\\\B@everyone\\\\b",
      "\\\\B@stream\\\\b",
    ],
  },
  reload: { configPrefixes: ["channels.zulip"] },
  configSchema: buildChannelConfigSchema(ZulipConfigSchema),
  config: {
    listAccountIds: (cfg) => listZulipAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZulipAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZulipAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        clearBaseFields: ["url", "baseUrl", "email", "apiKey", "streams", "defaultTopic"],
      }),
    isConfigured: (account) => Boolean(account.baseUrl && account.email && account.apiKey),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.baseUrl && account.email && account.apiKey),
      tokenSource: account.apiKeySource,
      baseUrlSource: account.baseUrlSource,
      emailSource: account.emailSource,
      apiKeySource: account.apiKeySource,
      baseUrl: account.baseUrl,
      streams: account.streams,
      alwaysReply: account.alwaysReply,
      defaultTopic: account.defaultTopic,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const zulipSection = cfg.channels?.zulip as ZulipConfig | undefined;
      const useAccountPath = Boolean(zulipSection?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.zulip.accounts.${resolvedAccountId}.`
        : "channels.zulip.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zulip"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        '- Zulip streams: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.zulip.groupPolicy="allowlist" + channels.zulip.groupAllowFrom to restrict senders.',
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeZulipMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeZulipTargetId,
      hint: "<stream:NAME[:topic]|user:email|#stream[:topic]|@email>",
    },
    formatTargetDisplay: ({ target }) => target,
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 10_000,
    resolveTarget: ({ cfg, to, accountId }) => {
      const raw = (to ?? "").trim();
      const parsed = parseZulipTarget(raw);
      if (!parsed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Zulip requires --target stream:<streamName>#<topic?> (topic optional).",
          ),
        };
      }
      const account = cfg ? resolveZulipAccount({ cfg, accountId }) : null;
      const stream = normalizeStreamName(parsed.stream);
      const topic = normalizeTopic(parsed.topic) || account?.defaultTopic || "general chat";
      if (!stream) {
        return { ok: false, error: new Error("Missing Zulip stream name") };
      }
      return { ok: true, to: `stream:${stream}#${topic}` };
    },
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveZulipAccount({ cfg, accountId });
      const parsed = parseZulipTarget(to);
      if (!parsed) {
        throw new Error(`Invalid Zulip target: ${to}`);
      }
      const stream = normalizeStreamName(parsed.stream);
      const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
      const auth = {
        baseUrl: account.baseUrl ?? "",
        email: account.email ?? "",
        apiKey: account.apiKey ?? "",
      };
      const result = await (
        await import("./zulip/send.js")
      ).sendZulipStreamMessage({
        auth,
        stream,
        topic,
        content: text,
      });
      return { channel: "zulip", messageId: String(result.id ?? "unknown") };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      // Note: Zulip "attachments" are links to uploaded files. We upload via /user_uploads
      // then post the resulting link into the stream/topic.
      if (!mediaUrl?.trim()) {
        throw new Error("Zulip media delivery requires mediaUrl.");
      }
      const account = resolveZulipAccount({ cfg, accountId });
      const parsed = parseZulipTarget(to);
      if (!parsed) {
        throw new Error(`Invalid Zulip target: ${to}`);
      }
      const stream = normalizeStreamName(parsed.stream);
      const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
      if (!stream) {
        throw new Error("Missing Zulip stream name");
      }
      const auth = {
        baseUrl: account.baseUrl ?? "",
        email: account.email ?? "",
        apiKey: account.apiKey ?? "",
      };

      const resolved = await resolveOutboundMedia({
        cfg,
        accountId: account.accountId,
        mediaUrl,
      });
      const uploadedUrl = await uploadZulipFile({
        auth,
        buffer: resolved.buffer,
        contentType: resolved.contentType,
        filename: resolved.filename ?? "attachment",
      });

      const caption = (text ?? "").trim();
      if (caption.length > account.textChunkLimit) {
        const chunks = getZulipRuntime().channel.text.chunkMarkdownText(
          caption,
          account.textChunkLimit,
        );
        let lastId: string | undefined;
        for (const chunk of chunks.length > 0 ? chunks : [caption]) {
          if (!chunk) {
            continue;
          }
          const res = await sendZulipStreamMessage({ auth, stream, topic, content: chunk });
          if (res.id != null) {
            lastId = String(res.id);
          }
        }
        const mediaRes = await sendZulipStreamMessage({
          auth,
          stream,
          topic,
          content: uploadedUrl,
        });
        if (mediaRes.id != null) {
          lastId = String(mediaRes.id);
        }
        return { channel: "zulip", messageId: lastId ?? "unknown" };
      } else {
        const content = caption ? `${caption}\n\n${uploadedUrl}` : uploadedUrl;
        const res = await sendZulipStreamMessage({ auth, stream, topic, content });
        return { channel: "zulip", messageId: String(res.id ?? "unknown") };
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!account.baseUrl || !account.email || !account.apiKey) {
        return { ok: false, error: "missing baseUrl/email/apiKey" };
      }
      try {
        const { zulipRequest } = await import("./zulip/client.js");
        const res = await zulipRequest({
          auth: { baseUrl: account.baseUrl, email: account.email, apiKey: account.apiKey },
          method: "GET",
          path: "/api/v1/users/me",
        });
        return { ok: true, me: res };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.baseUrl && account.email && account.apiKey),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  actions: zulipMessageActions,
  gateway: {
    startAccount: async (ctx) => {
      const accountId = normalizeAccountId(ctx.account.accountId ?? DEFAULT_ACCOUNT_ID);
      ctx.log?.info(`[${accountId}] starting zulip monitor`);
      const provider = await monitorZulipProvider({
        accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => {
          const current = ctx.getStatus();
          ctx.setStatus({ ...current, ...patch, accountId: current.accountId ?? ctx.accountId });
        },
      });
      activeProviders.set(accountId, provider);
      // Keep this Promise pending until the monitor's run loop actually exits.
      // The core gateway tracks startAccount's Promise settlement to detect
      // channel health — if it resolves immediately, the health-monitor thinks
      // the channel stopped and enters a restart loop.
      await provider.done;
    },
    stopAccount: async (ctx) => {
      const accountId = normalizeAccountId(ctx.account.accountId ?? DEFAULT_ACCOUNT_ID);
      activeProviders.get(accountId)?.stop();
      activeProviders.delete(accountId);
      ctx.log?.info(`[${accountId}] stopped zulip monitor`);
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const inputAny = input as Record<string, string | boolean | undefined>;
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Zulip env vars can only be used for the default account.";
      }
      const apiKey = (inputAny.apiKey as string | undefined) ?? input.botToken ?? input.token;
      const email = inputAny.email as string | undefined;
      const baseUrl = input.httpUrl;
      if (!input.useEnv && (!apiKey || !email || !baseUrl)) {
        return "Zulip requires --api-key, --email, and --http-url (or --use-env).";
      }
      if (baseUrl && !normalizeZulipBaseUrl(baseUrl)) {
        return "Zulip --http-url must include a valid base URL.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const inputAny = input as Record<string, string | boolean | undefined>;
      const apiKey = (inputAny.apiKey as string | undefined) ?? input.botToken ?? input.token;
      const email = inputAny.email as string | undefined;
      const baseUrl = (input.httpUrl ?? inputAny.url)?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "zulip" })
          : namedConfig;
      const zulipSection = (next.channels?.zulip ?? {}) as ZulipConfig;
      const zulipAccounts = (zulipSection.accounts ?? {}) as Record<string, ZulipAccountConfig>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...zulipSection,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(apiKey ? { apiKey } : {}),
                    ...(email ? { email } : {}),
                    ...(baseUrl ? { url: baseUrl } : {}),
                  }),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zulip: {
            ...zulipSection,
            enabled: true,
            accounts: {
              ...zulipAccounts,
              [accountId]: {
                ...zulipAccounts[accountId],
                enabled: true,
                ...(apiKey ? { apiKey } : {}),
                ...(email ? { email } : {}),
                ...(baseUrl ? { url: baseUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
};
