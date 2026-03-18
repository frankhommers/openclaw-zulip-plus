import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../shims/paths.js";

export const ZULIP_PROCESSED_MESSAGE_STATE_VERSION = 1;

type ZulipProcessedRange = {
  start: number;
  end: number;
};

type ZulipProcessedStreamState = {
  ranges: ZulipProcessedRange[];
};

export type ZulipProcessedMessageState = {
  version: number;
  watermarks: Record<string, ZulipProcessedStreamState>;
};

export function resolveZulipProcessedMessageStatePath(params?: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const accountId = params?.accountId?.trim().toLowerCase() || "default";
  return path.join(resolveStateDir(params?.env), "runtime", "zulip", `processed-message-state.${accountId}.json`);
}

function normalizeStreamKey(stream: string): string {
  return stream.trim().toLowerCase();
}

function createEmptyState(): ZulipProcessedMessageState {
  return {
    version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
    watermarks: {},
  };
}

function normalizeRanges(value: unknown): ZulipProcessedRange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ranges = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const candidate = entry as { start?: unknown; end?: unknown };
      if (
        typeof candidate.start !== "number" ||
        !Number.isFinite(candidate.start) ||
        typeof candidate.end !== "number" ||
        !Number.isFinite(candidate.end)
      ) {
        return undefined;
      }
      const start = Math.floor(Math.min(candidate.start, candidate.end));
      const end = Math.floor(Math.max(candidate.start, candidate.end));
      return { start, end };
    })
    .filter((entry): entry is ZulipProcessedRange => Boolean(entry))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: ZulipProcessedRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function getOrCreateStreamState(params: {
  state: ZulipProcessedMessageState;
  stream: string;
}): ZulipProcessedStreamState | undefined {
  const streamKey = normalizeStreamKey(params.stream);
  if (!streamKey) {
    return undefined;
  }
  if (!params.state.watermarks[streamKey]) {
    params.state.watermarks[streamKey] = { ranges: [] };
  }
  return params.state.watermarks[streamKey];
}

function mergeStates(base: ZulipProcessedMessageState, incoming: ZulipProcessedMessageState): ZulipProcessedMessageState {
  const merged = createEmptyState();
  const streamKeys = new Set([...Object.keys(base.watermarks), ...Object.keys(incoming.watermarks)]);
  for (const streamKey of streamKeys) {
    merged.watermarks[streamKey] = {
      ranges: normalizeRanges([
        ...(base.watermarks[streamKey]?.ranges ?? []),
        ...(incoming.watermarks[streamKey]?.ranges ?? []),
      ]),
    };
  }
  return merged;
}

export function isZulipMessageProcessed(params: {
  state: ZulipProcessedMessageState;
  stream: string;
  messageId: number;
}): boolean {
  if (!Number.isFinite(params.messageId)) {
    return false;
  }
  const streamKey = normalizeStreamKey(params.stream);
  if (!streamKey) {
    return false;
  }
  const ranges = params.state.watermarks[streamKey]?.ranges ?? [];
  return ranges.some((range) => params.messageId >= range.start && params.messageId <= range.end);
}

export function markZulipMessageProcessed(params: {
  state: ZulipProcessedMessageState;
  stream: string;
  messageId: number;
}): boolean {
  if (!Number.isFinite(params.messageId)) {
    return false;
  }
  const messageId = Math.floor(params.messageId);
  const streamState = getOrCreateStreamState(params);
  if (!streamState) {
    return false;
  }
  if (streamState.ranges.some((range) => messageId >= range.start && messageId <= range.end)) {
    return false;
  }
  streamState.ranges = normalizeRanges([...streamState.ranges, { start: messageId, end: messageId }]);
  return true;
}

export async function loadZulipProcessedMessageState(params?: {
  stateFilePath?: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ZulipProcessedMessageState> {
  const stateFilePath = params?.stateFilePath ?? resolveZulipProcessedMessageStatePath(params);
  let raw: string;
  try {
    raw = await fs.readFile(stateFilePath, "utf8");
  } catch {
    return createEmptyState();
  }

  try {
    const parsed = JSON.parse(raw) as { version?: unknown; watermarks?: unknown };
    if (
      parsed.version !== ZULIP_PROCESSED_MESSAGE_STATE_VERSION ||
      !parsed.watermarks ||
      typeof parsed.watermarks !== "object"
    ) {
      return createEmptyState();
    }
    const normalized = createEmptyState();
    for (const [stream, value] of Object.entries(parsed.watermarks)) {
      const streamKey = normalizeStreamKey(stream);
      if (!streamKey || !value || typeof value !== "object") {
        continue;
      }
      normalized.watermarks[streamKey] = {
        ranges: normalizeRanges((value as { ranges?: unknown }).ranges),
      };
    }
    return normalized;
  } catch {
    return createEmptyState();
  }
}

export async function writeZulipProcessedMessageState(params: {
  state: ZulipProcessedMessageState;
  stateFilePath?: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const stateFilePath = params.stateFilePath ?? resolveZulipProcessedMessageStatePath(params);
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true, mode: 0o700 });

  const mergedState = mergeStates(
    await loadZulipProcessedMessageState({ stateFilePath }).catch(() => createEmptyState()),
    params.state,
  );

  const tempPath = `${stateFilePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(mergedState, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, stateFilePath);
  await fs.chmod(stateFilePath, 0o600).catch(() => undefined);
}
