import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  SUBSCRIBED_TOKEN,
  type ZulipAccountConfig,
  type ZulipChatMode,
  type ZulipConfig,
  type ZulipReactionConfig,
} from "../types.js";
import { normalizeEmojiName, normalizeStreamName, normalizeTopic } from "./normalize.js";

export type ZulipTokenSource = "env" | "config" | "none";
export type ZulipBaseUrlSource = "env" | "config" | "none";
export type ZulipEmailSource = "env" | "config" | "none";

export type ZulipReactionWorkflowStage =
  | "queued"
  | "processing"
  | "toolRunning"
  | "retrying"
  | "success"
  | "partialSuccess"
  | "failure";

export type ResolvedZulipReactionWorkflow = {
  enabled: boolean;
  replaceStageReaction: boolean;
  minTransitionMs: number;
  stages: {
    queued?: string;
    processing?: string;
    toolRunning?: string;
    retrying?: string;
    success: string;
    partialSuccess?: string;
    failure: string;
  };
};

export type ResolvedZulipGenericReactionCallback = {
  enabled: boolean;
  includeRemoveOps: boolean;
};

export type ResolvedZulipReactions = {
  enabled: boolean;
  onStart: string;
  onSuccess: string;
  onFailure: string;
  clearOnFinish: boolean;
  workflow: ResolvedZulipReactionWorkflow;
  genericCallback: ResolvedZulipGenericReactionCallback;
};

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl?: string;
  email?: string;
  apiKey?: string;
  baseUrlSource: ZulipBaseUrlSource;
  emailSource: ZulipEmailSource;
  apiKeySource: ZulipTokenSource;
  streams: string[];
  alwaysReply: boolean;
  requireMention?: boolean;
  enableAdminActions: boolean;
  chatmode: ZulipChatMode;
  oncharPrefixes: string[];
  blockStreaming: boolean;
  blockStreamingCoalesce: { minChars?: number; idleMs?: number };
  dmPolicy: string;
  allowFrom: Array<string | number>;
  groupAllowFrom: Array<string | number>;
  groupPolicy: string;
  responsePrefix: string;
  defaultTopic: string;
  reactions: ResolvedZulipReactions;
  processingSpinner: {
    enabled: boolean;
    emoji: string[];
    intervalMs: number;
  };
  workingMessages: {
    enabled: boolean;
  };
  showThinking: {
    mode: "none" | "spinner" | "spoiler" | "both";
    debounceMs: number;
  };
  allowBotIds: number[];
  botLoopPrevention: {
    maxChainLength: number;
    cooldownMs: number;
  };
  textChunkLimit: number;
  config: ZulipAccountConfig;
};

const DEFAULT_TOPIC = "general chat";
const DEFAULT_TEXT_CHUNK_LIMIT = 10_000;
const DEFAULT_ALWAYS_REPLY = true;

const DEFAULT_REACTIONS: ResolvedZulipReactions = {
  enabled: true,
  onStart: "eyes",
  onSuccess: "check",
  onFailure: "warning",
  clearOnFinish: true,
  workflow: {
    enabled: true,
    replaceStageReaction: true,
    minTransitionMs: 1500,
    stages: {
      queued: "eyes",
      processing: "eyes",
      success: "check",
      partialSuccess: "warning",
      failure: "warning",
    },
  },
  genericCallback: {
    enabled: false,
    includeRemoveOps: false,
  },
};

const DEFAULT_PROCESSING_SPINNER = {
  enabled: false,
  emoji: [
    "new_moon",
    "waxing_crescent_moon",
    "first_quarter_moon",
    "waxing_moon",
    "full_moon",
    "waning_gibbous_moon",
    "last_quarter_moon",
    "waning_crescent_moon",
  ],
  intervalMs: 2000,
};

function resolveZulipSection(cfg: OpenClawConfig): ZulipConfig | undefined {
  return cfg.channels?.zulip as ZulipConfig | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = resolveZulipSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const configuredDefault = resolveZulipSection(cfg)?.defaultAccount?.trim();
  if (configuredDefault) {
    const normalized = normalizeAccountId(configuredDefault);
    const ids = listZulipAccountIds(cfg);
    if (ids.includes(normalized)) {
      return normalized;
    }
  }
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig | undefined {
  const accounts = cfg.channels?.zulip?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZulipAccountConfig | undefined;
}

function mergeZulipAccountConfig(cfg: OpenClawConfig, accountId: string): ZulipAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.zulip ?? {}) as ZulipAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return {
    ...base,
    ...account,
    actions: {
      ...base.actions,
      ...account.actions,
    },
  };
}

function resolveConfiguredBaseUrl(cfg: OpenClawConfig, accountId: string): string | undefined {
  const account = resolveAccountConfig(cfg, accountId);
  const accountUrl =
    account?.baseUrl?.trim() || account?.url?.trim() || account?.site?.trim() || account?.realm?.trim();
  if (accountUrl) {
    return accountUrl;
  }

  const section = cfg.channels?.zulip as ZulipAccountConfig | undefined;
  return (
    section?.baseUrl?.trim() ||
    section?.url?.trim() ||
    section?.site?.trim() ||
    section?.realm?.trim() ||
    undefined
  );
}

function normalizeStreamAllowlist(streams?: string[]): string[] {
  const entries = streams ?? [];
  if (entries.some((s) => s.trim() === SUBSCRIBED_TOKEN)) {
    return [SUBSCRIBED_TOKEN];
  }
  const normalized = entries.map((entry) => normalizeStreamName(entry)).filter(Boolean);
  return Array.from(new Set(normalized));
}

function resolveWorkflowMinTransitionMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_REACTIONS.workflow.minTransitionMs;
  }
  return Math.floor(raw);
}

function resolveZulipRequireMention(config: ZulipAccountConfig): boolean | undefined {
  if (typeof config.requireMention === "boolean") {
    return config.requireMention;
  }
  if (config.chatmode === "oncall") {
    return true;
  }
  if (config.chatmode === "onmessage") {
    return false;
  }
  return undefined;
}

function resolveReactions(config: ZulipReactionConfig | undefined): ResolvedZulipReactions {
  if (!config) {
    return DEFAULT_REACTIONS;
  }
  const enabled = config.enabled !== false;
  const onStart = normalizeEmojiName(config.onStart) || DEFAULT_REACTIONS.onStart;
  const onSuccess = normalizeEmojiName(config.onSuccess) || DEFAULT_REACTIONS.onSuccess;
  const onFailure = normalizeEmojiName(config.onFailure) || DEFAULT_REACTIONS.onFailure;
  const clearOnFinish = config.clearOnFinish !== false;

  const workflowStages = config.workflow?.stages;
  const workflow = {
    enabled: config.workflow?.enabled === true,
    replaceStageReaction: config.workflow?.replaceStageReaction !== false,
    minTransitionMs: resolveWorkflowMinTransitionMs(config.workflow?.minTransitionMs),
    stages: {
      queued: normalizeEmojiName(workflowStages?.queued) || onStart,
      processing: normalizeEmojiName(workflowStages?.processing) || onStart,
      toolRunning: normalizeEmojiName(workflowStages?.toolRunning) || undefined,
      retrying: normalizeEmojiName(workflowStages?.retrying) || undefined,
      success: normalizeEmojiName(workflowStages?.success) || onSuccess,
      partialSuccess: normalizeEmojiName(workflowStages?.partialSuccess) || onFailure,
      failure: normalizeEmojiName(workflowStages?.failure) || onFailure,
    },
  } satisfies ResolvedZulipReactionWorkflow;

  const genericCallback = {
    enabled: config.genericCallback?.enabled === true,
    includeRemoveOps: config.genericCallback?.includeRemoveOps === true,
  } satisfies ResolvedZulipGenericReactionCallback;

  return { enabled, onStart, onSuccess, onFailure, clearOnFinish, workflow, genericCallback };
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.zulip?.enabled !== false;
  const merged = mergeZulipAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envUrl = allowEnv ? process.env.ZULIP_URL?.trim() : undefined;
  const envSite = allowEnv ? process.env.ZULIP_SITE?.trim() : undefined;
  const envRealm = allowEnv ? process.env.ZULIP_REALM?.trim() : undefined;
  const envEmail = allowEnv ? process.env.ZULIP_EMAIL?.trim() : undefined;
  const envKey = allowEnv ? process.env.ZULIP_API_KEY?.trim() : undefined;

  const configUrl = resolveConfiguredBaseUrl(params.cfg, accountId);
  const configEmail = merged.email?.trim();
  const configKey = merged.apiKey?.trim();

  const baseUrl = (configUrl || envUrl || envSite || envRealm)?.replace(/\/+$/, "") || undefined;
  const email = configEmail || envEmail || undefined;
  const apiKey = configKey || envKey || undefined;
  const requireMention = resolveZulipRequireMention(merged);

  const baseUrlSource: ZulipBaseUrlSource =
    configUrl ? "config" : envUrl || envSite || envRealm ? "env" : "none";
  const emailSource: ZulipEmailSource = configEmail ? "config" : envEmail ? "env" : "none";
  const apiKeySource: ZulipTokenSource = configKey ? "config" : envKey ? "env" : "none";

  const streams = normalizeStreamAllowlist(merged.streams);
  const alwaysReply = merged.alwaysReply !== false && DEFAULT_ALWAYS_REPLY;
  const enableAdminActions = merged.enableAdminActions === true;
  const chatmode = merged.chatmode ?? "onmessage";
  const oncharPrefixes =
    merged.oncharPrefixes?.map((entry) => entry.trim()).filter(Boolean) ?? [">", "!"];
  const blockStreaming = merged.blockStreaming === true;
  const blockStreamingCoalesce = merged.blockStreamingCoalesce ?? {};
  const dmPolicy = merged.dmPolicy?.trim() || "disabled";
  const allowFrom = merged.allowFrom ?? [];
  const groupAllowFrom = merged.groupAllowFrom ?? [];
  const groupPolicy = merged.groupPolicy?.trim() || "open";
  const responsePrefix = merged.responsePrefix ?? "";
  const defaultTopic = normalizeTopic(merged.defaultTopic) || DEFAULT_TOPIC;
  const reactions = resolveReactions(merged.reactions);
  const spinnerCfg = merged.processingSpinner;
  const processingSpinner = {
    enabled: spinnerCfg?.enabled ?? DEFAULT_PROCESSING_SPINNER.enabled,
    emoji: spinnerCfg?.emoji?.length ? spinnerCfg.emoji : DEFAULT_PROCESSING_SPINNER.emoji,
    intervalMs: spinnerCfg?.intervalMs ?? DEFAULT_PROCESSING_SPINNER.intervalMs,
  };
  const workingMessages = {
    enabled: merged.workingMessages?.enabled !== false,
  };
  const showThinkingMode = merged.showThinking?.mode ?? "spoiler";
  const showThinking = {
    mode: (["none", "spinner", "spoiler", "both"] as const).includes(showThinkingMode as any)
      ? (showThinkingMode as "none" | "spinner" | "spoiler" | "both")
      : ("spoiler" as const),
    debounceMs:
      typeof merged.showThinking?.debounceMs === "number" &&
      Number.isFinite(merged.showThinking.debounceMs)
        ? Math.max(200, Math.floor(merged.showThinking.debounceMs))
        : 1500,
  };
  const allowBotIds = (merged.allowBotIds ?? [])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
  const botLoopPrevention = {
    maxChainLength:
      typeof merged.botLoopPrevention?.maxChainLength === "number" &&
      Number.isFinite(merged.botLoopPrevention.maxChainLength)
        ? Math.max(1, Math.floor(merged.botLoopPrevention.maxChainLength))
        : 5,
    cooldownMs:
      typeof merged.botLoopPrevention?.cooldownMs === "number" &&
      Number.isFinite(merged.botLoopPrevention.cooldownMs)
        ? Math.max(0, Math.floor(merged.botLoopPrevention.cooldownMs))
        : 5 * 60 * 1000,
  };
  const textChunkLimit =
    typeof merged.textChunkLimit === "number" ? merged.textChunkLimit : DEFAULT_TEXT_CHUNK_LIMIT;

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    email,
    apiKey,
    baseUrlSource,
    emailSource,
    apiKeySource,
    streams,
    alwaysReply,
    requireMention,
    enableAdminActions,
    chatmode,
    oncharPrefixes,
    blockStreaming,
    blockStreamingCoalesce,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    groupPolicy,
    responsePrefix,
    defaultTopic,
    reactions,
    processingSpinner,
    workingMessages,
    showThinking,
    allowBotIds,
    botLoopPrevention,
    textChunkLimit,
    config: merged,
  };
}

export function listEnabledZulipAccounts(cfg: OpenClawConfig): ResolvedZulipAccount[] {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
