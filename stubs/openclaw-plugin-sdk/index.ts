import os from "node:os";
import { z } from "zod";

export const DEFAULT_ACCOUNT_ID = "default";

export type OpenClawConfig = {
  channels?: Record<string, any>;
  agents?: {
    defaults?: Record<string, any>;
    list?: Array<Record<string, any>>;
  };
  [key: string]: any;
};

export type RuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
  exit?: (code?: number) => void;
  [key: string]: any;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  [key: string]: any;
};

export type ChannelMessageActionName = string;

export type ChannelMessageActionAdapter = {
  listActions?: (args: { cfg: OpenClawConfig }) => ChannelMessageActionName[];
  extractToolSend?: (args: { args: Record<string, any> }) => { to: string; accountId?: string } | null;
  handleAction?: (args: {
    action: ChannelMessageActionName;
    params: Record<string, any>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<any>;
  [key: string]: any;
};

export type ChannelGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string;
  groupId?: string;
  [key: string]: any;
};

export type WizardPrompter = {
  note: (message: string, title?: string) => Promise<void>;
  text: (params: {
    message: string;
    validate?: (value: string) => string | undefined;
  }) => Promise<string>;
  confirm: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  select: (params: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
  }) => Promise<string>;
  [key: string]: any;
};

export type ChannelOnboardingAdapter = {
  channel: string;
  getStatus: (args: { cfg: OpenClawConfig }) => Promise<any>;
  configure: (args: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    accountOverrides: Record<string, string | undefined>;
    shouldPromptAccountIds?: boolean;
  }) => Promise<{ cfg: OpenClawConfig; accountId?: string }>;
  disable: (cfg: OpenClawConfig) => OpenClawConfig;
  [key: string]: any;
};

export type AgentToolResult = {
  ok?: boolean;
  [key: string]: any;
};

export type PluginRuntime = any;

export type ChannelPlugin<T = unknown> = {
  id: string;
  meta?: Record<string, any>;
  defaults?: Record<string, any>;
  onboarding?: ChannelOnboardingAdapter;
  pairing?: {
    normalizeAllowEntry?: (entry: any) => any;
    [key: string]: any;
  };
  capabilities?: Record<string, any>;
  streaming?: Record<string, any>;
  groups?: {
    resolveRequireMention?: (params: any) => boolean | undefined;
    [key: string]: any;
  };
  mentions?: Record<string, any>;
  reload?: Record<string, any>;
  configSchema?: any;
  config?: {
    listAccountIds?: (cfg: any) => any;
    resolveAccount?: (cfg: any, accountId?: any) => any;
    defaultAccountId?: (cfg: any) => any;
    setAccountEnabled?: (params: any) => any;
    deleteAccount?: (params: any) => any;
    isConfigured?: (account: any) => boolean;
    describeAccount?: (account: any) => any;
    resolveAllowFrom?: (params: any) => any;
    formatAllowFrom?: (params: any) => any;
    [key: string]: any;
  };
  security?: {
    resolveDmPolicy?: (params: any) => any;
    collectWarnings?: (params: any) => any;
    [key: string]: any;
  };
  messaging?: {
    normalizeTarget?: (target: any) => any;
    targetResolver?: Record<string, any>;
    formatTargetDisplay?: (params: any) => any;
    [key: string]: any;
  };
  outbound?: {
    deliveryMode?: string;
    chunker?: (text: any, limit: any) => any;
    chunkerMode?: string;
    textChunkLimit?: number;
    resolveTarget?: (params: any) => any;
    sendText?: (params: any) => Promise<any>;
    sendMedia?: (params: any) => Promise<any>;
    [key: string]: any;
  };
  status?: {
    defaultRuntime?: Record<string, any>;
    buildChannelSummary?: (params: any) => any;
    probeAccount?: (params: any) => Promise<any>;
    buildAccountSnapshot?: (params: any) => any;
    [key: string]: any;
  };
  actions?: ChannelMessageActionAdapter;
  gateway?: {
    startAccount?: (ctx: any) => Promise<any>;
    stopAccount?: (ctx: any) => Promise<any>;
    [key: string]: any;
  };
  setup?: {
    resolveAccountId?: (params: any) => any;
    applyAccountName?: (params: any) => any;
    validateInput?: (params: any) => any;
    applyAccountConfig?: (params: any) => any;
    [key: string]: any;
  };
  [key: string]: any;
};

export type ChannelPluginDefinition<T = unknown> = {
  plugin: ChannelPlugin<T>;
  [key: string]: any;
};

export type OpenClawPluginApi = {
  runtime: PluginRuntime;
  registerChannel: (definition: ChannelPluginDefinition) => void;
  [key: string]: any;
};

export const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().int().nonnegative().optional(),
    idleMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const DmPolicySchema = z.enum(["disabled", "open", "allowlist", "pairing"]);
export const GroupPolicySchema = z.enum(["disabled", "open", "allowlist"]);

export function emptyPluginConfigSchema() {
  return z.object({}).passthrough();
}

export function normalizeAccountId(accountId?: string | null): string {
  const trimmed = String(accountId ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

export function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  [key: string]: any;
}) {
  const section = params.cfg.channels?.[params.channel] ?? {};
  const id = normalizeAccountId(params.accountId);
  const account = section.accounts?.[id] ?? {};
  const responsePrefix = account.responsePrefix ?? section.responsePrefix ?? "";
  return {
    responsePrefix,
    onModelSelected: (_ctx: { model: string; provider?: string; thinkLevel?: string }) => {
      return;
    },
  };
}

export function createScopedPairingAccess(_params: any) {
  return {
    async upsertPairingRequest(args: { id: string; meta?: Record<string, any> }) {
      return {
        code: `PAIR-${String(args.id ?? "user").toUpperCase()}`,
        created: true,
      };
    },
  };
}

export async function fetchWithSsrFGuard(params: {
  url: string;
  init?: RequestInit;
}) {
  const response = await fetch(params.url, params.init);
  return {
    response,
    release: async () => {
      return;
    },
  };
}

export function resolvePreferredOpenClawTmpDir(): string {
  return os.tmpdir();
}

export function jsonResult<T extends Record<string, any>>(payload: T): T {
  return payload;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options?: { integer?: boolean },
): number | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (options?.integer && !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; allowEmpty?: boolean },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: false; allowEmpty?: boolean },
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean; allowEmpty?: boolean },
): string | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (options?.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }
  const value = String(raw);
  if (!options?.allowEmpty && value.trim().length === 0) {
    if (options?.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }
  return value;
}

export function buildMentionRegexes(_cfg: OpenClawConfig, agentId?: string): RegExp[] {
  const escaped = String(agentId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) {
    return [];
  }
  return [new RegExp(`(^|\\s)@${escaped}(\\b|$)`, "i")];
}

export function matchesMentionPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function convertMarkdownTables(text: string): string {
  return text;
}

export function buildChannelConfigSchema<T>(schema: T): T {
  return schema;
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const current = params.cfg.channels?.[params.channelKey] ?? {};
  const accounts = { ...(current.accounts ?? {}) };
  accounts[accountId] = {
    ...(accounts[accountId] ?? {}),
    ...(params.name ? { name: params.name } : {}),
  };
  return {
    ...params.cfg,
    channels: {
      ...(params.cfg.channels ?? {}),
      [params.channelKey]: {
        ...current,
        accounts,
      },
    },
  };
}

export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig {
  const section = params.cfg.channels?.[params.sectionKey] ?? {};
  const accountId = normalizeAccountId(params.accountId);
  const accounts = { ...(section.accounts ?? {}) };
  accounts[accountId] = { ...(accounts[accountId] ?? {}), enabled: params.enabled };
  return {
    ...params.cfg,
    channels: {
      ...(params.cfg.channels ?? {}),
      [params.sectionKey]: {
        ...section,
        ...(params.allowTopLevel && accountId === DEFAULT_ACCOUNT_ID ? { enabled: params.enabled } : {}),
        accounts,
      },
    },
  };
}

export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig {
  const section = { ...(params.cfg.channels?.[params.sectionKey] ?? {}) };
  const accounts = { ...(section.accounts ?? {}) };
  delete accounts[normalizeAccountId(params.accountId)];
  for (const field of params.clearBaseFields ?? []) {
    delete (section as Record<string, any>)[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...(params.cfg.channels ?? {}),
      [params.sectionKey]: {
        ...section,
        accounts,
      },
    },
  };
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig {
  const section = params.cfg.channels?.[params.channelKey] ?? {};
  const name = section.name;
  if (!name) {
    return params.cfg;
  }
  const accounts = { ...(section.accounts ?? {}) };
  const current = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  accounts[DEFAULT_ACCOUNT_ID] = { ...current, name };
  return {
    ...params.cfg,
    channels: {
      ...(params.cfg.channels ?? {}),
      [params.channelKey]: {
        ...section,
        accounts,
      },
    },
  };
}

export function formatPairingApproveHint(channel: string): string {
  return `Approve ${channel} pairing requests in the CLI.`;
}

export function resolveChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  resolveChannelLimitMb: (args: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
  accountId: string;
}): number | undefined {
  const mb = params.resolveChannelLimitMb({ cfg: params.cfg, accountId: params.accountId });
  if (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) {
    return undefined;
  }
  return Math.floor(mb * 1024 * 1024);
}
