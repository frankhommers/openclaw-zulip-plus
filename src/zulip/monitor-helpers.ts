import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type ResponsePrefixContext = {
  model?: string;
  modelFull?: string;
  provider?: string;
  thinkingLevel?: string;
  identityName?: string;
};

export function extractShortModelName(fullModel: string): string {
  const slash = fullModel.lastIndexOf("/");
  const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;
  return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

export function formatInboundFromLabel(params: {
  isGroup: boolean;
  groupLabel?: string;
  groupId?: string;
  directLabel: string;
  directId?: string;
  groupFallback?: string;
}): string {
  if (params.isGroup) {
    const label = params.groupLabel?.trim() || params.groupFallback || "Group";
    const id = params.groupId?.trim();
    return id ? `${label} id:${id}` : label;
  }

  const directLabel = params.directLabel.trim();
  const directId = params.directId?.trim();
  if (!directId || directId === directLabel) {
    return directLabel;
  }
  return `${directLabel} id:${directId}`;
}

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "main";
  }
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) {
    return trimmed;
  }
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function listAgents(cfg: OpenClawConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveIdentityName(cfg: OpenClawConfig, agentId: string): string | undefined {
  const entry = resolveAgentEntry(cfg, agentId);
  return entry?.identity?.name?.trim() || undefined;
}

/**
 * Sanitizes a thread ID for safe use in session keys and file paths.
 * Replaces unsafe characters with hyphens to avoid path traversal and encoding issues.
 * Falls back to a SHA-256 hash prefix if the result exceeds 200 characters.
 */
export function sanitizeThreadId(threadId: string): string {
  const sanitized = threadId
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (sanitized.length > 200) {
    return createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  }
  return sanitized;
}

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string; sanitizedThreadId?: string } {
  const rawThreadId = (params.threadId ?? "").trim();
  if (!rawThreadId) {
    return {
      sessionKey: params.baseSessionKey,
      parentSessionKey: undefined,
      sanitizedThreadId: undefined,
    };
  }
  const sanitizedThreadId = sanitizeThreadId(rawThreadId);
  if (!sanitizedThreadId) {
    return {
      sessionKey: params.baseSessionKey,
      parentSessionKey: undefined,
      sanitizedThreadId: undefined,
    };
  }
  const useSuffix = params.useSuffix ?? true;
  const sessionKey = useSuffix
    ? `${params.baseSessionKey}:thread:${sanitizedThreadId}`
    : params.baseSessionKey;
  return { sessionKey, parentSessionKey: params.parentSessionKey, sanitizedThreadId };
}
