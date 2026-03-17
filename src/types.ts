export type ZulipChatMode = "oncall" | "onmessage" | "onchar";

export type ZulipReactionWorkflowStageConfig = {
  queued?: string;
  processing?: string;
  toolRunning?: string;
  retrying?: string;
  success?: string;
  partialSuccess?: string;
  failure?: string;
};

export type ZulipReactionWorkflowConfig = {
  /** Enable stage-based workflow reactions. Defaults to false for backward compatibility. */
  enabled?: boolean;
  /** Remove previous stage emoji before posting the next stage emoji. Defaults to true. */
  replaceStageReaction?: boolean;
  /** Minimum delay between stage transitions in milliseconds. Defaults to 1500ms. */
  minTransitionMs?: number;
  /** Emoji mapping by workflow stage. */
  stages?: ZulipReactionWorkflowStageConfig;
};

export type ZulipGenericReactionCallbackConfig = {
  /**
   * Enable synthetic callbacks for non-button reactions.
   * Defaults to false to keep existing behavior unchanged.
   */
  enabled?: boolean;
  /**
   * Include reaction removal events (`op: "remove"`).
   * Defaults to false to avoid noise/loops.
   */
  includeRemoveOps?: boolean;
};

export type ZulipReactionConfig = {
  enabled?: boolean;
  onStart?: string;
  onSuccess?: string;
  onFailure?: string;
  onError?: string;
  /**
   * Whether to remove the `onStart` reaction after responding (default: true).
   * Set to false to leave the `onStart` reaction (e.g. ":eyes:") on the message.
   */
  clearOnFinish?: boolean;
  /**
   * Optional stage-based reactions for richer status signaling.
   * Disabled by default so legacy behavior remains unchanged.
   */
  workflow?: ZulipReactionWorkflowConfig;
  /**
   * Optional synthetic callback path for non-button reactions.
   * Disabled by default for safety.
   */
  genericCallback?: ZulipGenericReactionCallbackConfig;
};

export type ZulipAccountConfig = {
  name?: string;
  capabilities?: string[];
  enabled?: boolean;
  configWrites?: boolean;
  enableAdminActions?: boolean;

  baseUrl?: string;
  url?: string;
  site?: string;
  realm?: string;
  email?: string;
  apiKey?: string;

  /** Stream allowlist to monitor (names; without leading "#"). */
  streams?: string[];

  chatmode?: ZulipChatMode;
  oncharPrefixes?: string[];
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: string;

  /**
   * Reply to every message in monitored streams/topics (default: true).
   *
   * When false, OpenClaw may act "trigger-only" depending on global group policy
   * and mention detection.
   */
  alwaysReply?: boolean;

  /**
   * Default topic when target omits a topic.
   */
  defaultTopic?: string;

  /** Reaction indicators while responding. */
  reactions?: ZulipReactionConfig;

  /** Animated emoji spinner during processing. */
  processingSpinner?: {
    enabled?: boolean;
    emoji?: string[];
    intervalMs?: number;
  };

  /** "Still working..." messages during processing. Default: enabled. */
  workingMessages?: {
    enabled?: boolean;
  };

  /** Maximum chars before chunking. */
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";

  /** Maximum inbound/outbound media size in MB (default: 5MB). */
  mediaMaxMb?: number;

  blockStreaming?: boolean;
  blockStreamingCoalesce?: { minChars?: number; idleMs?: number };
  responsePrefix?: string;

  /**
   * Require @mention to respond in streams (default: false).
   * When true, the bot only replies when mentioned by name or @-syntax.
   * If unset, derived from `alwaysReply` (default true -> requireMention false).
   */
  requireMention?: boolean;
};

export type ZulipConfig = {
  defaultAccount?: string;
  accounts?: Record<string, ZulipAccountConfig>;
} & ZulipAccountConfig;

/** Magic token for dynamic stream discovery via bot subscriptions. */
export const SUBSCRIBED_TOKEN = "{subscribed}";

/** Returns true if the streams array contains the `{subscribed}` token. */
export function isSubscribedMode(streams: string[]): boolean {
  return streams.some((s) => s.trim() === SUBSCRIBED_TOKEN);
}
