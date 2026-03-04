import crypto from "node:crypto";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions, createScopedPairingAccess } from "openclaw/plugin-sdk";
import { getZulipRuntime } from "../runtime.js";
import { isSubscribedMode, SUBSCRIBED_TOKEN } from "../types.js";
import {
  resolveZulipAccount,
  type ResolvedZulipAccount,
  type ResolvedZulipReactions,
  type ZulipReactionWorkflowStage,
} from "./accounts.js";
import type { ZulipAuth } from "./client.js";
import type { ZulipHttpError } from "./client.js";
import { zulipRequest } from "./client.js";
import { createDedupeCache } from "./dedupe.js";
import {
  buildZulipCheckpointId,
  clearZulipInFlightCheckpoint,
  isZulipCheckpointStale,
  loadZulipInFlightCheckpoints,
  markZulipCheckpointFailure,
  prepareZulipCheckpointForRecovery,
  type ZulipInFlightCheckpoint,
  ZULIP_INFLIGHT_CHECKPOINT_VERSION,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT,
  writeZulipInFlightCheckpoint,
} from "./inflight-checkpoints.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import { buildZulipQueuePlan, buildZulipRegisterNarrow } from "./queue-plan.js";
import {
  getReactionButtonSession,
  handleReactionEvent,
  startReactionButtonSessionCleanup,
  stopReactionButtonSessionCleanup,
} from "./reaction-buttons.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import {
  deleteZulipMessage,
  editZulipStreamMessage,
  sanitizeBackticks,
  sendZulipStreamMessage,
} from "./send.js";
import { ToolProgressAccumulator } from "./tool-progress.js";
import { downloadZulipUploads, resolveOutboundMedia, uploadZulipFile } from "./uploads.js";

export type MonitorZulipOptions = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
  }) => void;
};

type ZulipRegisterResponse = {
  result: "success" | "error";
  msg?: string;
  queue_id?: string;
  last_event_id?: number;
};

type ZulipEventMessage = {
  id: number;
  type: string;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  stream_id?: number;
  subject?: string;
  content?: string;
  content_type?: string;
  timestamp?: number;
};

type ZulipReactionEvent = {
  id?: number;
  type: "reaction";
  op: "add" | "remove";
  message_id: number;
  emoji_name: string;
  emoji_code: string;
  user_id: number;
  user?: {
    email?: string;
    full_name?: string;
    user_id?: number;
  };
  message?: ZulipEventMessage;
};

type ZulipUpdateMessageEvent = {
  id?: number;
  type: "update_message";
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
};

type ZulipEvent = {
  id?: number;
  type?: string;
  message?: ZulipEventMessage;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  op?: "add" | "remove" | "update" | "peer_add" | "peer_remove";
  subscriptions?: Array<{ stream_id?: number; name?: string }>;
  message_id?: number;
  emoji_name?: string;
  emoji_code?: string;
  user_id?: number;
  user?: {
    email?: string;
    full_name?: string;
    user_id?: number;
  };
};

type ZulipSubscriptionEvent = {
  id?: number;
  type: "subscription";
  op: "add" | "remove" | "update" | "peer_add" | "peer_remove";
  subscriptions?: Array<{ stream_id?: number; name?: string }>;
};

type ZulipEventsResponse = {
  result: "success" | "error";
  msg?: string;
  events?: ZulipEvent[];
  last_event_id?: number;
};

type ZulipMeResponse = {
  result: "success" | "error";
  msg?: string;
  user_id?: number;
  email?: string;
  full_name?: string;
};

export const DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
export const KEEPALIVE_INITIAL_DELAY_MS = 10_000;
export const KEEPALIVE_REPEAT_INTERVAL_MS = 10_000;
export const ZULIP_SHUTDOWN_NOTICE_PREFIX = "♻️ Gateway restart in progress";
export const ZULIP_KEEPALIVE_PREFIX = "🔧 Still working...";
export const ZULIP_RECOVERY_PREFIX = "🔄 Gateway restarted";
export const ZULIP_RECOVERY_NOTICE = `${ZULIP_RECOVERY_PREFIX} - resuming the previous task now...`;

const STALE_STATUS_PREFIXES = [
  ZULIP_KEEPALIVE_PREFIX,
  ZULIP_SHUTDOWN_NOTICE_PREFIX,
  ZULIP_RECOVERY_PREFIX,
];

export function isStaleStatusMessage(content: string): boolean {
  const trimmed = content.trim();
  return STALE_STATUS_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export async function cleanupStaleStatusMessages(params: {
  auth: ZulipAuth;
  streams: string[];
  fetchMessages: (opts: {
    stream: string;
    senderEmail: string;
    limit: number;
  }) => Promise<Array<{ id: number; content: string }>>;
  deleteMessage: (messageId: number) => Promise<void>;
  maxPerStream?: number;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}): Promise<void> {
  const maxPerStream = params.maxPerStream ?? 500;
  let totalDeleted = 0;

  params.logger.info(
    `[zulip] stale status cleanup: scanning ${params.streams.length} stream(s) for leftover status messages`,
  );

  for (const stream of params.streams) {
    let messages: Array<{ id: number; content: string }>;
    try {
      messages = await params.fetchMessages({
        stream,
        senderEmail: params.auth.email,
        limit: maxPerStream,
      });
    } catch (err) {
      params.logger.warn(
        `[zulip] stale status cleanup: failed to fetch messages for stream "${stream}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const stale = messages.filter((m) => isStaleStatusMessage(m.content));
    params.logger.info(
      `[zulip] stale status cleanup: stream "${stream}": ${messages.length} messages fetched, ${stale.length} stale`,
    );
    for (const msg of stale) {
      try {
        await params.deleteMessage(msg.id);
        totalDeleted++;
        params.logger.debug?.(
          `[zulip] stale status cleanup: deleted message ${msg.id} in stream "${stream}"`,
        );
      } catch (err) {
        params.logger.warn(
          `[zulip] stale status cleanup: failed to delete message ${msg.id} in stream "${stream}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (totalDeleted > 0) {
    params.logger.info(
      `[zulip] stale status cleanup: deleted ${totalDeleted} leftover status message(s) across ${params.streams.length} stream(s)`,
    );
  } else {
    params.logger.info(`[zulip] stale status cleanup: no stale messages found`);
  }
}

const DEFAULT_ONCHAR_PREFIXES = [">", "!"];

function formatKeepaliveElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${totalSeconds}s`;
  }
  if (seconds <= 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatClockHms(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatClockHmsInTimeZone(timestampMs: number, timeZone?: string): string {
  if (timeZone?.trim()) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone,
      }).format(new Date(timestampMs));
    } catch {
      // Fall back to local clock formatting.
    }
  }
  return formatClockHms(timestampMs);
}

function resolveKeepaliveTimeZone(cfg: OpenClawConfig): string | undefined {
  const tz = cfg.agents?.defaults?.userTimezone?.trim();
  return tz || undefined;
}

export function buildKeepaliveMessageContent(
  elapsedMs: number,
  lastActivityAtMs = Date.now(),
  timeZone?: string,
): string {
  const timestamp = formatClockHmsInTimeZone(lastActivityAtMs, timeZone);
  return `${ZULIP_KEEPALIVE_PREFIX} (${formatKeepaliveElapsed(elapsedMs)} elapsed, last activity ${timestamp})`;
}

export function startPeriodicKeepalive(params: {
  sendPing: (elapsedMs: number) => Promise<void>;
  initialDelayMs?: number;
  repeatIntervalMs?: number;
  now?: () => number;
}): () => void {
  const initialDelayMs = params.initialDelayMs ?? KEEPALIVE_INITIAL_DELAY_MS;
  const repeatIntervalMs = params.repeatIntervalMs ?? KEEPALIVE_REPEAT_INTERVAL_MS;
  const now = params.now ?? (() => Date.now());

  const startedAt = now();
  let stopped = false;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;

  const firePing = () => {
    if (stopped) {
      return;
    }
    void params.sendPing(Math.max(0, now() - startedAt)).catch(() => undefined);
  };

  const initialTimer = setTimeout(() => {
    firePing();
    if (stopped) {
      return;
    }
    repeatTimer = setInterval(() => {
      firePing();
    }, repeatIntervalMs);
    repeatTimer.unref?.();
  }, initialDelayMs);

  initialTimer.unref?.();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(initialTimer);
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }
  };
}

export function createBestEffortShutdownNoticeSender(params: {
  sendNotice: () => Promise<void>;
  log?: (message: string) => void;
}): () => void {
  let sent = false;
  return () => {
    if (sent) {
      return;
    }
    sent = true;
    void params.sendNotice().catch((err) => {
      params.log?.(`[zulip] shutdown notice failed: ${String(err)}`);
    });
  };
}

export function computeZulipMonitorBackoffMs(params: {
  attempt: number;
  status: number | null;
  retryAfterMs?: number;
}): number {
  const cappedAttempt = Math.max(1, Math.min(10, Math.floor(params.attempt)));
  // Zulip can rate-limit /events fairly aggressively on some deployments; prefer slower retries.
  const base = params.status === 429 ? 10_000 : 500;
  const max = params.status === 429 ? 120_000 : 30_000;
  const exp = Math.min(max, base * 2 ** Math.min(7, cappedAttempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.max(exp + jitter, params.retryAfterMs ?? 0, base);
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function waitForDispatcherIdleWithTimeout(params: {
  waitForIdle: () => Promise<void>;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const idlePromise = params.waitForIdle();
  try {
    const outcome = await Promise.race<"idle" | "timeout">([
      idlePromise.then(() => "idle"),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), params.timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);

    if (outcome === "timeout") {
      params.onTimeout?.();
      // Avoid unhandled rejections after timeout while cleanup continues.
      idlePromise.catch(() => undefined);
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function extractZulipHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status?: unknown }).status;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  const match = /Zulip API error \((\d{3})\):/.exec(String(err));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildAuth(account: ResolvedZulipAccount): ZulipAuth {
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing zulip baseUrl/email/apiKey");
  }
  return {
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
  };
}

function buildTopicKey(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  const encoded = encodeURIComponent(normalized);
  if (encoded.length <= 80) {
    return encoded;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 64)}~${digest}`;
}

function isZulipUpdateMessageEvent(event: ZulipEvent): event is ZulipUpdateMessageEvent {
  return event.type === "update_message";
}

function parseTopicRenameEvent(
  event: ZulipEvent,
): { fromTopic: string; toTopic: string } | undefined {
  if (!isZulipUpdateMessageEvent(event)) {
    return undefined;
  }

  const fromTopic = normalizeTopic(event.orig_topic ?? event.orig_subject);
  const toTopic = normalizeTopic(event.topic ?? event.subject);
  if (!fromTopic || !toTopic) {
    return undefined;
  }

  if (buildTopicKey(fromTopic) === buildTopicKey(toTopic)) {
    return undefined;
  }

  return { fromTopic, toTopic };
}

function resolveCanonicalTopicSessionKey(params: {
  aliasesByStream: Map<string, Map<string, string>>;
  stream: string;
  topic: string;
}): string {
  const aliases = params.aliasesByStream.get(params.stream);
  const topicKey = buildTopicKey(params.topic);
  if (!aliases) {
    return topicKey;
  }

  let canonicalKey = topicKey;
  const visited = new Set<string>();
  const visitedOrder: string[] = [];

  while (true) {
    const next = aliases.get(canonicalKey);
    if (!next || next === canonicalKey || visited.has(canonicalKey)) {
      break;
    }
    visited.add(canonicalKey);
    visitedOrder.push(canonicalKey);
    canonicalKey = next;
  }

  if (visitedOrder.length > 0) {
    for (const alias of visitedOrder) {
      aliases.set(alias, canonicalKey);
    }
  }

  return canonicalKey;
}

function recordTopicRenameAlias(params: {
  aliasesByStream: Map<string, Map<string, string>>;
  stream: string;
  fromTopic: string;
  toTopic: string;
}): boolean {
  const fromTopic = normalizeTopic(params.fromTopic);
  const toTopic = normalizeTopic(params.toTopic);
  if (!fromTopic || !toTopic) {
    return false;
  }

  const fromCanonicalKey = resolveCanonicalTopicSessionKey({
    aliasesByStream: params.aliasesByStream,
    stream: params.stream,
    topic: fromTopic,
  });
  const toCanonicalKey = resolveCanonicalTopicSessionKey({
    aliasesByStream: params.aliasesByStream,
    stream: params.stream,
    topic: toTopic,
  });

  if (fromCanonicalKey === toCanonicalKey) {
    return false;
  }

  let aliases = params.aliasesByStream.get(params.stream);
  if (!aliases) {
    aliases = new Map<string, string>();
    params.aliasesByStream.set(params.stream, aliases);
  }

  aliases.set(toCanonicalKey, fromCanonicalKey);
  return true;
}

function extractZulipTopicDirective(text: string): { topic?: string; text: string } {
  const raw = text ?? "";
  // Allow an agent to create/switch topics by prefixing a reply with:
  // [[zulip_topic: <topic>]]
  const match = /^\s*\[\[zulip_topic:\s*([^\]]+)\]\]\s*\n?/i.exec(raw);
  if (!match) {
    return { text: raw };
  }
  const topic = normalizeTopic(match[1]) || undefined;
  const nextText = raw.slice(match[0].length).trimStart();
  if (!topic) {
    return { text: nextText };
  }
  // Keep topics reasonably short (UI-friendly).
  const truncated = topic.length > 60 ? topic.slice(0, 60).trim() : topic;
  return { topic: truncated || topic, text: nextText };
}

function resolveOncharPrefixes(prefixes: string[] | undefined): string[] {
  const cleaned = prefixes?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
  return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}

function stripOncharPrefix(
  text: string,
  prefixes: string[],
): { triggered: boolean; stripped: string } {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }
    if (trimmed.startsWith(prefix)) {
      return {
        triggered: true,
        stripped: trimmed.slice(prefix.length).trimStart(),
      };
    }
  }
  return { triggered: false, stripped: text };
}

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(zulip|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  const allowFrom = params.allowFrom;
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeAllowEntry(params.senderId);
  const normalizedSenderName = params.senderName ? normalizeAllowEntry(params.senderName) : "";
  return allowFrom.some(
    (entry) =>
      entry === normalizedSenderId || (normalizedSenderName && entry === normalizedSenderName),
  );
}

function resolveMarkdownTableMode(params: {
  cfg: OpenClawConfig;
  accountId: string;
}) {
  const core = getZulipRuntime();
  const resolveMode = (
    core.channel.text as {
      resolveMarkdownTableMode?: (args: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
      }) => unknown;
    }
  ).resolveMarkdownTableMode;
  if (typeof resolveMode !== "function") {
    return "off";
  }
  return resolveMode({
    cfg: params.cfg,
    channel: "zulip",
    accountId: params.accountId,
  });
}

function sanitizeBackticksCompat(text: string): string {
  try {
    return sanitizeBackticks(text);
  } catch {
    return text;
  }
}

async function fetchZulipMe(auth: ZulipAuth, abortSignal?: AbortSignal): Promise<ZulipMeResponse> {
  return await zulipRequest<ZulipMeResponse>({
    auth,
    method: "GET",
    path: "/api/v1/users/me",
    abortSignal,
  });
}

async function registerQueue(params: {
  auth: ZulipAuth;
  stream?: string;
  eventTypes?: string[];
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const form: Record<string, string> = {
    event_types: JSON.stringify(params.eventTypes ?? ["message", "reaction", "update_message"]),
    apply_markdown: "false",
  };
  if (params.stream) {
    form.narrow = buildZulipRegisterNarrow(params.stream);
  }
  const res = await zulipRequest<ZulipRegisterResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form,
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(
      params.stream
        ? `[zulip] registered queue ${res.queue_id} (narrow=stream:${params.stream})`
        : `[zulip] registered queue ${res.queue_id}`,
    );
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

async function fetchSubscribedStreams(params: {
  auth: ZulipAuth;
  abortSignal?: AbortSignal;
}): Promise<string[]> {
  const res = await zulipRequest<{
    result: "success" | "error";
    msg?: string;
    subscriptions?: Array<{ name?: string }>;
  }>({
    auth: params.auth,
    method: "GET",
    path: "/api/v1/users/me/subscriptions",
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success") {
    throw new Error(res.msg || "Failed to fetch Zulip subscriptions");
  }
  const normalized = (res.subscriptions ?? [])
    .map((entry) => normalizeStreamName(entry.name))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function extractSubscribedStreamNames(evt: ZulipSubscriptionEvent): string[] {
  return Array.from(
    new Set((evt.subscriptions ?? []).map((entry) => normalizeStreamName(entry.name)).filter(Boolean)),
  );
}

async function pollEvents(params: {
  auth: ZulipAuth;
  queueId: string;
  lastEventId: number;
  abortSignal?: AbortSignal;
}): Promise<ZulipEventsResponse> {
  // Wrap the parent signal with a per-poll timeout so we don't hang forever
  // if the Zulip server goes unresponsive during long-poll.
  // Must exceed Zulip's server-side long-poll timeout (typically 90s) to avoid
  // unnecessary client-side aborts that trigger queue re-registration and risk
  // dropping messages in the gap between old and new queues.
  const POLL_TIMEOUT_MS = 120_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onTimeout = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  timer = setTimeout(onTimeout, POLL_TIMEOUT_MS);

  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  params.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await zulipRequest<ZulipEventsResponse>({
      auth: params.auth,
      method: "GET",
      path: "/api/v1/events",
      query: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
        // Be explicit: we want long-poll behavior to avoid tight polling loops that can trigger 429s.
        dont_block: false,
      },
      abortSignal: controller.signal,
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.abortSignal?.removeEventListener("abort", onParentAbort);
  }
}

function shouldIgnoreMessage(params: {
  message: ZulipEventMessage;
  botUserId: number;
  streams: string[];
}): { ignore: boolean; reason?: string } {
  const msg = params.message;
  if (msg.sender_id === params.botUserId) {
    return { ignore: true, reason: "self" };
  }
  if (msg.type !== "stream") {
    return { ignore: false };
  }
  const stream = normalizeStreamName(msg.display_recipient);
  if (!stream) {
    return { ignore: true, reason: "missing-stream" };
  }
  if (params.streams.length > 0 && !isSubscribedMode(params.streams) && !params.streams.includes(stream)) {
    return { ignore: true, reason: "not-allowed-stream" };
  }
  return { ignore: false };
}

async function sendZulipDirectMessage(params: {
  auth: ZulipAuth;
  recipientId: number;
  content: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  await zulipRequest({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/messages",
    form: {
      type: "direct",
      to: JSON.stringify([params.recipientId]),
      content: params.content,
    },
    abortSignal: params.abortSignal,
  });
}

/**
 * Send a one-time "I only work in streams" reply to DM senders.
 * Uses a Set to avoid spamming the same sender repeatedly.
 */
async function replyToDm(params: {
  auth: ZulipAuth;
  senderId: number;
  dmNotifiedSenders: Set<number>;
  log?: (message: string) => void;
}): Promise<void> {
  if (params.dmNotifiedSenders.has(params.senderId)) {
    return;
  }
  params.dmNotifiedSenders.add(params.senderId);
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/messages",
      form: {
        type: "direct",
        to: JSON.stringify([params.senderId]),
        content:
          "👋 I only work in Zulip streams — mention me in a stream to chat! DMs are not supported.",
      },
    });
    params.log?.(`[zulip] sent DM redirect to user ${params.senderId}`);
  } catch (err) {
    params.log?.(`[zulip] failed to send DM redirect: ${String(err)}`);
  }
}

async function resolveDmDispatch(params: {
  auth: ZulipAuth;
  account: ResolvedZulipAccount;
  senderId: number;
  senderIdentity: string;
  senderName?: string;
  dmNotifiedSenders: Set<number>;
  pairingAccess: ReturnType<typeof createScopedPairingAccess>;
  log?: (message: string) => void;
}): Promise<{ allowProcessing: boolean }> {
  const dmPolicy = (params.account.dmPolicy || "disabled").trim().toLowerCase();
  if (dmPolicy === "open") {
    return { allowProcessing: true };
  }

  const normalizedAllowFrom = normalizeAllowList(params.account.allowFrom ?? []);
  const senderAllowed = isSenderAllowed({
    senderId: params.senderIdentity,
    senderName: params.senderName,
    allowFrom: normalizedAllowFrom,
  });
  if (dmPolicy === "allowlist") {
    return { allowProcessing: senderAllowed };
  }

  if (dmPolicy === "pairing") {
    if (senderAllowed) {
      return { allowProcessing: true };
    }
    const { code, created } = await params.pairingAccess.upsertPairingRequest({
      id: params.senderIdentity,
      meta: { name: params.senderName },
    });
    params.log?.(`[zulip] pairing request sender=${params.senderIdentity} created=${created}`);
    if (created) {
      try {
        const pairingReply = getZulipRuntime().channel.pairing.buildPairingReply({
          channel: "zulip",
          idLine: `Your Zulip ID: ${params.senderIdentity}`,
          code,
        });
        await sendZulipDirectMessage({
          auth: params.auth,
          recipientId: params.senderId,
          content: pairingReply,
        });
      } catch (err) {
        params.log?.(`[zulip] pairing reply failed for ${params.senderIdentity}: ${String(err)}`);
      }
    }
    return { allowProcessing: false };
  }

  await replyToDm({
    auth: params.auth,
    senderId: params.senderId,
    dmNotifiedSenders: params.dmNotifiedSenders,
    log: params.log,
  });
  return { allowProcessing: false };
}

async function sendTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "start",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}

async function stopTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "stop",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}

async function bestEffortReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  op: "add" | "remove";
  emojiName: string;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}) {
  const emojiName = params.emojiName;
  if (!emojiName) {
    return;
  }
  try {
    if (params.op === "add") {
      await addZulipReaction({
        auth: params.auth,
        messageId: params.messageId,
        emojiName,
        abortSignal: params.abortSignal,
        log: params.log,
      });
      return;
    }
    await removeZulipReaction({
      auth: params.auth,
      messageId: params.messageId,
      emojiName,
      abortSignal: params.abortSignal,
    });
  } catch (err) {
    params.log?.(`[zulip] reaction ${params.op} ${emojiName} failed: ${String(err)}`);
  }
}

type ReactionTransitionController = {
  transition: (
    stage: ZulipReactionWorkflowStage,
    options?: { abortSignal?: AbortSignal; force?: boolean },
  ) => Promise<void>;
};

function resolveStageEmoji(params: {
  reactions: ResolvedZulipReactions;
  stage: ZulipReactionWorkflowStage;
}): string {
  if (params.reactions.workflow.enabled) {
    const stageEmoji = params.reactions.workflow.stages[params.stage];
    return stageEmoji ?? "";
  }
  switch (params.stage) {
    case "queued":
    case "processing":
    case "toolRunning":
    case "retrying":
      return params.reactions.onStart;
    case "success":
      return params.reactions.onSuccess;
    case "partialSuccess":
    case "failure":
      return params.reactions.onFailure;
    default:
      return "";
  }
}

function createReactionTransitionController(params: {
  auth: ZulipAuth;
  messageId: number;
  reactions: ResolvedZulipReactions;
  log?: (message: string) => void;
  now?: () => number;
}): ReactionTransitionController {
  const now = params.now ?? (() => Date.now());
  let activeEmoji = "";
  let activeStage: ZulipReactionWorkflowStage | null = null;
  let lastTransitionAt = 0;

  return {
    transition: async (stage, options) => {
      const emojiName = resolveStageEmoji({ reactions: params.reactions, stage });
      const force = options?.force === true;
      const workflow = params.reactions.workflow;

      if (workflow.enabled && !force) {
        if (activeStage === stage) {
          return;
        }
        if (workflow.minTransitionMs > 0 && lastTransitionAt > 0) {
          const elapsed = now() - lastTransitionAt;
          if (elapsed < workflow.minTransitionMs) {
            return;
          }
        }
      }

      if (!emojiName) {
        activeStage = stage;
        if (force) {
          lastTransitionAt = now();
        }
        return;
      }

      if (
        workflow.enabled &&
        workflow.replaceStageReaction &&
        activeEmoji &&
        activeEmoji !== emojiName
      ) {
        await bestEffortReaction({
          auth: params.auth,
          messageId: params.messageId,
          op: "remove",
          emojiName: activeEmoji,
          log: params.log,
          abortSignal: options?.abortSignal,
        });
      }

      if (activeEmoji !== emojiName) {
        await bestEffortReaction({
          auth: params.auth,
          messageId: params.messageId,
          op: "add",
          emojiName,
          log: params.log,
          abortSignal: options?.abortSignal,
        });
        activeEmoji = emojiName;
      }

      activeStage = stage;
      lastTransitionAt = now();
    },
  };
}

function withWorkflowReactionStages<
  T extends {
    sendToolResult: (payload: ReplyPayload) => boolean;
    sendBlockReply: (payload: ReplyPayload) => boolean;
    sendFinalReply: (payload: ReplyPayload) => boolean;
  },
>(
  dispatcher: T,
  reactions: ResolvedZulipReactions,
  controller: ReactionTransitionController,
  abortSignal?: AbortSignal,
): T {
  return {
    ...dispatcher,
    sendToolResult: (payload: ReplyPayload) => {
      if (reactions.workflow.stages.toolRunning) {
        void controller.transition("toolRunning", { abortSignal });
      }
      return dispatcher.sendToolResult(payload);
    },
    sendBlockReply: (payload: ReplyPayload) => {
      if (reactions.workflow.stages.processing) {
        void controller.transition("processing", { abortSignal });
      }
      return dispatcher.sendBlockReply(payload);
    },
    sendFinalReply: (payload: ReplyPayload) => {
      if (reactions.workflow.stages.processing) {
        void controller.transition("processing", { abortSignal });
      }
      return dispatcher.sendFinalReply(payload);
    },
  };
}

async function deliverReply(params: {
  account: ResolvedZulipAccount;
  auth: ZulipAuth;
  stream: string;
  topic: string;
  directRecipientId?: number;
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}) {
  const core = getZulipRuntime();
  const logger = core.logging.getChildLogger({ channel: "zulip" });
  const isDirect = typeof params.directRecipientId === "number";

  const topicDirective = extractZulipTopicDirective(params.payload.text ?? "");
  const topic = topicDirective.topic ?? params.topic;
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    accountId: params.account.accountId,
  });
  const convertMarkdownTables = (
    core.channel.text as {
      convertMarkdownTables?: (text: string, mode: unknown) => string;
    }
  ).convertMarkdownTables;
  const convertedText =
    typeof convertMarkdownTables === "function"
      ? convertMarkdownTables(topicDirective.text, tableMode)
      : topicDirective.text;
  const text = sanitizeBackticksCompat(convertedText);
  const mediaUrls = (params.payload.mediaUrls ?? []).filter(Boolean);
  const mediaUrl = params.payload.mediaUrl?.trim();
  if (mediaUrl) {
    mediaUrls.unshift(mediaUrl);
  }

  const sendTextChunks = async (value: string) => {
    const chunks = core.channel.text.chunkMarkdownText(value, params.account.textChunkLimit);
    for (const chunk of chunks.length > 0 ? chunks : [value]) {
      if (!chunk) {
        continue;
      }
      if (isDirect) {
        await sendZulipDirectMessage({
          auth: params.auth,
          recipientId: params.directRecipientId as number,
          content: chunk,
          abortSignal: params.abortSignal,
        });
      } else {
        const response = await sendZulipStreamMessage({
          auth: params.auth,
          stream: params.stream,
          topic,
          content: chunk,
          abortSignal: params.abortSignal,
        });
        // Delivery receipt verification: check message ID in response
        if (!response || typeof response.id !== "number") {
          logger.warn(`[zulip] sendZulipStreamMessage returned invalid or missing message ID`);
        }
      }
    }
  };

  const trimmedText = text.trim();
  if (!trimmedText && mediaUrls.length === 0) {
    logger.debug?.(`[zulip] deliverReply: empty response (no text, no media) — skipping`);
    return;
  }
  if (mediaUrls.length === 0) {
    await sendTextChunks(text);
    return;
  }

  // Match core outbound behavior: treat text as a caption for the first media item.
  // If the caption is very long, send it as text chunks first to avoid exceeding limits.
  let caption = trimmedText;
  if (caption.length > params.account.textChunkLimit) {
    await sendTextChunks(text);
    caption = "";
  }

  for (const source of mediaUrls) {
    const resolved = await resolveOutboundMedia({
      cfg: params.cfg,
      accountId: params.account.accountId,
      mediaUrl: source,
    });
    const uploadedUrl = await uploadZulipFile({
      auth: params.auth,
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename ?? "attachment",
      abortSignal: params.abortSignal,
    });
    const content = caption ? `${caption}\n\n${uploadedUrl}` : uploadedUrl;
    if (isDirect) {
      await sendZulipDirectMessage({
        auth: params.auth,
        recipientId: params.directRecipientId as number,
        content,
        abortSignal: params.abortSignal,
      });
    } else {
      const response = await sendZulipStreamMessage({
        auth: params.auth,
        stream: params.stream,
        topic,
        content,
        abortSignal: params.abortSignal,
      });
      // Delivery receipt verification: check message ID in response
      if (!response || typeof response.id !== "number") {
        logger.warn(`[zulip] sendZulipStreamMessage returned invalid or missing message ID`);
      }
    }
    caption = "";
  }
}

export async function monitorZulipProvider(
  opts: MonitorZulipOptions,
): Promise<{ stop: () => void; done: Promise<void> }> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args: unknown[]) => core.logging.getChildLogger().info(args.map(String).join(" ")),
    error: (...args: unknown[]) => core.logging.getChildLogger().error(args.map(String).join(" ")),
    exit: (code: number) => {
      throw new Error("Runtime exit not available");
    },
  };

  const logger = core.logging.getChildLogger({ channel: "zulip", accountId: account.accountId });

  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error(`Zulip credentials missing for account "${account.accountId}"`);
  }
  if (!account.streams.length) {
    throw new Error(
      `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
    );
  }

  const auth = buildAuth(account);
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  let stopped = false;
  const stop = () => {
    stopped = true;
    abortController.abort();
  };
  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  const run = async () => {
    // Start reaction button session cleanup
    startReactionButtonSessionCleanup();

    const me = await fetchZulipMe(auth, abortSignal);
    if (me.result !== "success" || typeof me.user_id !== "number") {
      throw new Error(me.msg || "Failed to fetch Zulip bot identity");
    }
    const botUserId = me.user_id;
    const botDisplayName = me.full_name?.trim() || "Agent";
    logger.warn(`[zulip-debug][${account.accountId}] bot user_id=${botUserId}`);

    const fetchBotMessagesForStream = async (opts: {
      stream: string;
      senderEmail: string;
      limit: number;
    }): Promise<Array<{ id: number; content: string }>> => {
      const narrow = JSON.stringify([
        { operator: "sender", operand: opts.senderEmail },
        { operator: "stream", operand: opts.stream },
      ]);
      const res = await zulipRequest<{
        result: "success" | "error";
        messages?: Array<{ id: number; content: string }>;
      }>({
        auth,
        method: "GET",
        path: "/api/v1/messages",
        query: {
          anchor: "newest",
          num_before: String(opts.limit),
          num_after: "0",
          narrow,
          apply_markdown: false,
        },
        abortSignal,
      });
      if (res.result !== "success") {
        logger.warn(
          `[zulip] stale status cleanup: /messages API returned non-success for stream "${opts.stream}": ${JSON.stringify(res)}`,
        );
        return [];
      }
      return res.messages ?? [];
    };

    const deleteBotMessage = async (messageId: number): Promise<void> => {
      await deleteZulipMessage({ auth, messageId, abortSignal });
    };

    // Dedupe cache prevents reprocessing messages after queue re-registration or reconnect.
    const dedupe = createDedupeCache({ ttlMs: 5 * 60 * 1000, maxSize: 500 });
    const oncharEnabled = account.chatmode === "onchar";
    const oncharPrefixes = resolveOncharPrefixes(account.oncharPrefixes);
    const pairingAccess = createScopedPairingAccess({
      core,
      channel: "zulip",
      accountId: account.accountId,
    });

    // Track DM senders we've already notified to avoid spam.
    const dmNotifiedSenders = new Set<number>();
    // Topic-rename alias map per stream: renamed-topic-key -> canonical-topic-key.
    const topicAliasesByStream = new Map<string, Map<string, string>>();

    const handleMessage = async (
      msg: ZulipEventMessage,
      messageOptions?: { recoveryCheckpoint?: ZulipInFlightCheckpoint },
    ) => {
      if (typeof msg.id !== "number") {
        return;
      }
      if (dedupe.check(String(msg.id))) {
        return;
      }
      const ignore = shouldIgnoreMessage({ message: msg, botUserId, streams: account.streams });
      if (ignore.ignore) {
        return;
      }

      const isRecovery = Boolean(messageOptions?.recoveryCheckpoint);
      const isDM = msg.type !== "stream";
      const senderName =
        msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(msg.sender_id);
      const senderIdentity = msg.sender_email?.trim() || String(msg.sender_id);

      if (isDM) {
        const dmDispatch = await resolveDmDispatch({
          auth,
          account,
          senderId: msg.sender_id,
          senderIdentity,
          senderName,
          dmNotifiedSenders,
          pairingAccess,
          log: (message) => logger.debug?.(message),
        });
        if (!dmDispatch.allowProcessing) {
          return;
        }
      }

      const stream = isDM ? "" : normalizeStreamName(msg.display_recipient);
      const topic = normalizeTopic(msg.subject) || account.defaultTopic;
      const content = msg.content ?? "";
      if (!isDM && !stream) {
        return;
      }
      if (!isDM) {
        const groupPolicy = (account.groupPolicy || "open").trim().toLowerCase();
        if (groupPolicy === "disabled") {
          return;
        }
        if (groupPolicy === "allowlist") {
          const normalizedGroupAllowFrom = normalizeAllowList(account.groupAllowFrom ?? []);
          const groupAllowed = isSenderAllowed({
            senderId: senderIdentity,
            senderName,
            allowFrom: normalizedGroupAllowFrom,
          });
          if (!groupAllowed) {
            return;
          }
        }
      }
      if (isRecovery) {
        logger.warn(
          `[zulip:${account.accountId}] replaying recovery checkpoint for message ${msg.id} (${isDM ? `dm:${senderIdentity}` : `${stream}#${topic}`})`,
        );
      }
      // Defer the definitive empty-content check until after upload processing —
      // image-only messages have content (upload URLs) that gets stripped later,
      // but should still be processed as media. Quick pre-check: bail only if
      // content is truly blank AND contains no upload references at all.
      if (!content.trim() && !content.includes("/user_uploads/")) {
        return;
      }

      core.channel.activity.record({
        channel: "zulip",
        accountId: account.accountId,
        direction: "inbound",
        at: Date.now(),
      });
      opts.statusSink?.({ lastInboundAt: Date.now() });

      // Per-handler delivery signal: allows reply delivery to complete even if the monitor
      // is stopping (e.g. gateway restart). Without this, in-flight HTTP calls to Zulip get
      // aborted immediately, wasting the LLM tokens already spent generating the response.
      const DELIVERY_GRACE_MS = 10_000;
      const DELIVERY_TIMEOUT_MS = 1_200_000;
      const deliveryController = new AbortController();
      const deliverySignal = deliveryController.signal;
      const deliveryTimer = setTimeout(() => {
        if (!deliveryController.signal.aborted) deliveryController.abort();
      }, DELIVERY_TIMEOUT_MS);
      const onMainAbortForDelivery = () => {
        // Give in-flight deliveries a grace period to finish before hard abort
        setTimeout(() => {
          if (!deliveryController.signal.aborted) deliveryController.abort();
        }, DELIVERY_GRACE_MS);
      };
      abortSignal.addEventListener("abort", onMainAbortForDelivery, { once: true });

      const sendShutdownNoticeOnce =
        !isDM
          ? createBestEffortShutdownNoticeSender({
              sendNotice: async () => {
                await sendZulipStreamMessage({
                  auth,
                  stream,
                  topic,
                  content:
                    `${ZULIP_SHUTDOWN_NOTICE_PREFIX} - reconnecting now. If this turn is interrupted, please resend in a moment.`,
                  abortSignal: deliverySignal,
                });
              },
              log: (message) => logger.debug?.(message),
            })
          : () => {};
      const onMainAbortShutdownNotice = () => {
        if (!isDM) {
          sendShutdownNoticeOnce();
        }
      };
      if (!isDM) {
        abortSignal.addEventListener("abort", onMainAbortShutdownNotice, { once: true });
        if (abortSignal.aborted) {
          onMainAbortShutdownNotice();
        }
      }

      const reactions = account.reactions;
      const reactionController =
        reactions.enabled && reactions.workflow.enabled
          ? createReactionTransitionController({
              auth,
              messageId: msg.id,
              reactions,
              log: (m) => logger.debug?.(m),
            })
          : null;

      if (reactionController) {
        await reactionController.transition("queued", { abortSignal });
      } else if (reactions.enabled) {
        await bestEffortReaction({
          auth,
          messageId: msg.id,
          op: "add",
          emojiName: reactions.onStart,
          log: (m) => logger.debug?.(m),
          abortSignal,
        });
      }

      // Typing indicator refresh: Zulip expires typing indicators after ~15s server-side
      let typingRefreshInterval: ReturnType<typeof setInterval> | undefined;

      // Send typing indicator while the agent processes, and refresh every 10s.
      if (typeof msg.stream_id === "number") {
        const streamId = msg.stream_id;
        sendTypingIndicator({ auth, streamId, topic, abortSignal }).catch(
          () => undefined,
        );
        typingRefreshInterval = setInterval(() => {
          sendTypingIndicator({ auth, streamId, topic, abortSignal }).catch(
            () => undefined,
          );
        }, 10_000);
      }

      const inboundUploads = await downloadZulipUploads({
        cfg,
        accountId: account.accountId,
        auth,
        content,
        abortSignal,
      });
      const mediaPaths = inboundUploads.map((entry) => entry.path);
      const mediaUrls = inboundUploads.map((entry) => entry.url);
      const mediaTypes = inboundUploads.map((entry) => entry.contentType ?? "");

      // Strip downloaded upload URLs from the content so the native image loader
      // doesn't try to open raw /user_uploads/... paths as local files.
      let cleanedContent = content;
      for (const upload of inboundUploads) {
        // Replace both the full URL and any relative /user_uploads/ path variants.
        cleanedContent = cleanedContent.replaceAll(upload.url, upload.placeholder);
        try {
          const urlObj = new URL(upload.url);
          cleanedContent = cleanedContent.replaceAll(urlObj.pathname, upload.placeholder);
        } catch {
          // Ignore URL parse errors.
        }
      }

      if (oncharEnabled) {
        const oncharResult = stripOncharPrefix(cleanedContent, oncharPrefixes);
        if (!oncharResult.triggered) {
          return;
        }
        cleanedContent = oncharResult.stripped;
      }

      // Now that uploads are resolved, bail if there's truly nothing to process:
      // no text content AND no media attachments.
      if (!cleanedContent.trim() && inboundUploads.length === 0) {
        return;
      }

      const peerId = isDM ? senderIdentity : stream;

      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        peer: { kind: "channel", id: peerId },
      });
      const baseSessionKey = route.sessionKey;
      const sessionKey = isDM
        ? baseSessionKey
        : `${baseSessionKey}:topic:${resolveCanonicalTopicSessionKey({
            aliasesByStream: topicAliasesByStream,
            stream,
            topic,
          })}`;

      const to = isDM ? `user:${senderIdentity}` : `stream:${stream}#${topic}`;
      const from = isDM ? `zulip:user:${senderIdentity}` : `zulip:channel:${stream}`;

      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
      const cleanedForMentions = content.replace(/@\*\*([^*]+)\*\*/g, "@$1");
      const wasMentioned =
        !isDM && core.channel.mentions.matchesMentionPatterns(cleanedForMentions, mentionRegexes);

      const body = core.channel.reply.formatInboundEnvelope({
        channel: "Zulip",
        from: isDM ? senderName : `${stream} (${topic || account.defaultTopic})`,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        body: isDM
          ? `${cleanedContent}\n[zulip message id: ${msg.id}]`
          : `${cleanedContent}\n[zulip message id: ${msg.id} stream: ${stream} topic: ${topic}]`,
        chatType: isDM ? "direct" : "channel",
        sender: { name: senderName, id: String(msg.sender_id) },
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: cleanedContent,
        CommandBody: cleanedContent,
        From: from,
        To: to,
        SessionKey: sessionKey,
        AccountId: route.accountId,
        ChatType: isDM ? "direct" : "channel",
        ThreadLabel: isDM ? undefined : topic,
        MessageThreadId: isDM ? undefined : topic,
        ConversationLabel: isDM ? senderName : `${stream}#${topic}`,
        GroupSubject: isDM ? undefined : stream,
        GroupChannel: isDM ? undefined : `#${stream}`,
        GroupSystemPrompt: !isDM && account.alwaysReply
          ? "Always reply to every message in this Zulip stream/topic. If a full response isn't needed, acknowledge briefly in 1 short sentence. To start a new topic, prefix your reply with: [[zulip_topic: <topic>]]"
          : undefined,
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        SenderName: senderName,
        SenderId: String(msg.sender_id),
        MessageSid: String(msg.id),
        WasMentioned: isDM ? undefined : wasMentioned,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: to,
        Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        MediaPath: mediaPaths[0],
        MediaUrl: mediaUrls[0],
        MediaType: mediaTypes[0],
        MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
        MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
        CommandAuthorized: true,
      });

      const nowMs = Date.now();
      let checkpoint: ZulipInFlightCheckpoint | undefined;
      if (!isDM) {
        checkpoint = messageOptions?.recoveryCheckpoint
          ? prepareZulipCheckpointForRecovery({
              checkpoint: messageOptions.recoveryCheckpoint,
              nowMs,
            })
          : {
              version: ZULIP_INFLIGHT_CHECKPOINT_VERSION,
              checkpointId: buildZulipCheckpointId({
                accountId: account.accountId,
                messageId: msg.id,
              }),
              accountId: account.accountId,
              stream,
              topic,
              messageId: msg.id,
              senderId: String(msg.sender_id),
              senderName,
              senderEmail: msg.sender_email,
              cleanedContent,
              body,
              sessionKey,
              from,
              to,
              wasMentioned,
              streamId: msg.stream_id,
              timestampMs: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
              mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
              mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
              mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              retryCount: 0,
            };
        try {
          await writeZulipInFlightCheckpoint({ checkpoint });
        } catch (err) {
          runtime.error?.(`[zulip] failed to persist in-flight checkpoint: ${String(err)}`);
        }
      }

      const { onModelSelected: originalOnModelSelected, ...prefixOptions } =
        createReplyPrefixOptions({
          cfg,
          agentId: route.agentId,
          channel: "zulip",
          accountId: account.accountId,
        });
      type ModelSelectedContext = Parameters<NonNullable<typeof originalOnModelSelected>>[0];
      const onModelSelected = (ctx: ModelSelectedContext) => {
        originalOnModelSelected?.(ctx);
        if (ctx.model && toolProgress) {
          toolProgress.setModel(ctx.model);
        }
      };

      let successfulDeliveries = 0;
      const toolProgress = !isDM
        ? new ToolProgressAccumulator({
            auth,
            stream,
            topic,
            name: botDisplayName,
            abortSignal: deliverySignal,
            log: (m) => logger.debug?.(m),
          })
        : null;
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
            const kind = info?.kind;
            // Batch tool result summaries into a single message that gets edited.
            // Only batch text-only tool payloads; media payloads go through normally.
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            if (kind === "tool" && !hasMedia && payload.text?.trim() && toolProgress) {
              toolProgress.addLine(payload.text.trim());
              // Count as a successful delivery since the accumulator handles send/edit.
              successfulDeliveries += 1;
              opts.statusSink?.({ lastOutboundAt: Date.now() });
              core.channel.activity.record({
                channel: "zulip",
                accountId: account.accountId,
                direction: "outbound",
                at: Date.now(),
              });
              return;
            }

            // Finalize the accumulated tool progress before sending non-tool replies,
            // so the batched tool message appears above the block/final reply.
            if (kind !== "tool" && toolProgress?.hasContent) {
              await toolProgress.finalize();
            }

            // Use deliverySignal (not abortSignal) so in-flight replies survive
            // monitor shutdown with a grace period instead of being killed instantly.
            await deliverReply({
              account,
              auth,
              stream,
              topic,
              directRecipientId: isDM ? msg.sender_id : undefined,
              payload,
              cfg,
              abortSignal: deliverySignal,
            });
            successfulDeliveries += 1;
            opts.statusSink?.({ lastOutboundAt: Date.now() });
            core.channel.activity.record({
              channel: "zulip",
              accountId: account.accountId,
              direction: "outbound",
              at: Date.now(),
            });
          },
          onError: (err: unknown) => {
            runtime.error?.(`zulip reply failed: ${String(err)}`);
          },
        });
      const dispatchDriver = reactionController
        ? withWorkflowReactionStages(dispatcher, reactions, reactionController, abortSignal)
        : dispatcher;

      let keepaliveMessageId: number | undefined;
      let keepaliveLastActivityAtMs = Date.now();
      const keepaliveTimeZone = resolveKeepaliveTimeZone(cfg);

      const stopKeepalive = isDM
        ? () => {}
        : startPeriodicKeepalive({
            sendPing: async (elapsedMs) => {
              keepaliveLastActivityAtMs = Date.now();
              // If tool progress has an active batched message, update it with
              // a heartbeat instead of sending a separate keepalive message.
              if (toolProgress?.hasContent) {
                toolProgress.addHeartbeat(elapsedMs);
                return;
              }
              const content = buildKeepaliveMessageContent(
                elapsedMs,
                keepaliveLastActivityAtMs,
                keepaliveTimeZone,
              );
              if (keepaliveMessageId) {
                await editZulipStreamMessage({
                  auth,
                  messageId: keepaliveMessageId,
                  content,
                  abortSignal: deliverySignal,
                });
                return;
              }
              const response = await sendZulipStreamMessage({
                auth,
                stream,
                topic,
                content,
                abortSignal: deliverySignal,
              });
              if (typeof response.id === "number") {
                keepaliveMessageId = response.id;
              }
            },
          });

      let ok = false;
      let lastDispatchError: unknown;
      const MAX_DISPATCH_RETRIES = 2;
      try {
        for (let attempt = 0; attempt <= MAX_DISPATCH_RETRIES; attempt++) {
          try {
            if (reactionController) {
              await reactionController.transition("processing", { abortSignal });
            }
            await core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher: dispatchDriver,
              replyOptions: {
                ...replyOptions,
                disableBlockStreaming: !account.blockStreaming,
                onModelSelected,
              },
            });
            ok = true;
            lastDispatchError = undefined;
            break;
          } catch (err) {
            ok = false;
            lastDispatchError = err;
            const isRetryable =
              attempt < MAX_DISPATCH_RETRIES &&
              !(err instanceof Error && err.name === "AbortError");
            if (isRetryable) {
              if (reactionController) {
                await reactionController.transition("retrying", { abortSignal });
              }
              runtime.error?.(
                `zulip dispatch failed (attempt ${attempt + 1}/${MAX_DISPATCH_RETRIES + 1}, retrying in 2s): ${String(err)}`,
              );
              await sleep(2000, abortSignal).catch(() => undefined);
              continue;
            }
            opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
            runtime.error?.(`zulip dispatch failed: ${String(err)}`);
          }
        }
      } finally {
        // Ensure all queued outbound sends are flushed before cleanup.
        dispatcher.markComplete();
        try {
          await waitForDispatcherIdleWithTimeout({
            waitForIdle: () => dispatcher.waitForIdle(),
            timeoutMs: DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS,
            onTimeout: () => {
              logger.warn(
                `[zulip] dispatcher.waitForIdle timed out after ${DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS}ms; continuing cleanup`,
              );
            },
          });
        } finally {
          markDispatchIdle();
          // Finalize any remaining tool progress (best-effort final edit).
          // Use finalizeWithError() on failure so the header shows ❌ instead of ✅.
          if (toolProgress) {
            const finalizePromise = ok ? toolProgress.finalize() : toolProgress.finalizeWithError();
            await finalizePromise.catch((err) => {
              logger.debug?.(`[zulip] tool progress finalize failed: ${String(err)}`);
            });
          }
          // Clean up periodic keepalive timers.
          stopKeepalive();
          if (keepaliveMessageId) {
            await deleteZulipMessage({
              auth,
              messageId: keepaliveMessageId,
              abortSignal: deliverySignal,
            }).catch(() => undefined);
            keepaliveMessageId = undefined;
          }
          // Clean up typing refresh interval (before stopTypingIndicator)
          clearInterval(typingRefreshInterval);
          // Clean up delivery abort controller listener/timer (do not hard-abort here).
          clearTimeout(deliveryTimer);
          abortSignal.removeEventListener("abort", onMainAbortForDelivery);
          if (!isDM) {
            abortSignal.removeEventListener("abort", onMainAbortShutdownNotice);
          }

          // Stop typing indicator now that the reply has been sent.
          if (typeof msg.stream_id === "number") {
            stopTypingIndicator({
              auth,
              streamId: msg.stream_id,
              topic,
              abortSignal: deliverySignal,
            }).catch(() => undefined);
          }

          // Visible failure message: post an actual user-visible message when dispatch fails
          if (ok === false) {
            try {
              const failureMessage =
                "⚠️ I ran into an error processing your message — please try again. (Error has been logged)";
              if (isDM) {
                await sendZulipDirectMessage({
                  auth,
                  recipientId: msg.sender_id,
                  content: failureMessage,
                  abortSignal: deliverySignal,
                });
              } else {
                await sendZulipStreamMessage({
                  auth,
                  stream,
                  topic,
                  content: failureMessage,
                  abortSignal: deliverySignal,
                });
              }
            } catch {
              // Best effort — if this fails, at least the reaction emoji will show the failure
            }
          }

          // Use deliverySignal for final reactions so they can still be posted
          // during graceful shutdown (the grace period covers these too).
          if (reactions.enabled) {
            if (reactionController) {
              const finalStage: ZulipReactionWorkflowStage = ok
                ? "success"
                : successfulDeliveries > 0
                  ? "partialSuccess"
                  : "failure";
              await reactionController.transition(finalStage, {
                abortSignal: deliverySignal,
                force: true,
              });
            } else {
              if (reactions.clearOnFinish) {
                await bestEffortReaction({
                  auth,
                  messageId: msg.id,
                  op: "remove",
                  emojiName: reactions.onStart,
                  log: (m) => logger.debug?.(m),
                  abortSignal: deliverySignal,
                });
              }
              const finalEmoji = ok ? reactions.onSuccess : reactions.onFailure;
              await bestEffortReaction({
                auth,
                messageId: msg.id,
                op: "add",
                emojiName: finalEmoji,
                log: (m) => logger.debug?.(m),
                abortSignal: deliverySignal,
              });
            }
          }

          if (checkpoint) {
            try {
              if (ok) {
                await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId });
              } else {
                checkpoint = markZulipCheckpointFailure({
                  checkpoint,
                  error: lastDispatchError ?? "dispatch failed",
                });
                await writeZulipInFlightCheckpoint({ checkpoint });
              }
            } catch (err) {
              runtime.error?.(`[zulip] failed to update in-flight checkpoint: ${String(err)}`);
            }
          }
        }
      }
    };

    const resumedCheckpointIds = new Set<string>();

    const reactionMessageContexts = new Map<
      number,
      {
        stream: string;
        topic: string;
        capturedAt: number;
      }
    >();
    const REACTION_MESSAGE_CONTEXT_TTL_MS = 30 * 60 * 1000;
    const REACTION_MESSAGE_CONTEXT_MAX = 1_000;

    const normalizeReactionSourceFromMessage = (message?: ZulipEventMessage) => {
      if (!message) {
        return null;
      }
      if (message.type && message.type !== "stream") {
        return null;
      }
      const stream = normalizeStreamName(
        typeof message.display_recipient === "string" ? message.display_recipient : "",
      );
      const topic = normalizeTopic(message.subject) || account.defaultTopic;
      if (!stream || !topic) {
        return null;
      }
      return { stream, topic };
    };

    const rememberReactionMessageContext = (message: ZulipEventMessage) => {
      if (typeof message.id !== "number") {
        return;
      }
      const source = normalizeReactionSourceFromMessage(message);
      if (!source) {
        return;
      }
      reactionMessageContexts.set(message.id, {
        ...source,
        capturedAt: Date.now(),
      });
      if (reactionMessageContexts.size > REACTION_MESSAGE_CONTEXT_MAX) {
        for (const [messageId] of reactionMessageContexts) {
          reactionMessageContexts.delete(messageId);
          if (reactionMessageContexts.size <= REACTION_MESSAGE_CONTEXT_MAX) {
            break;
          }
        }
      }
    };

    const resolveReactionSource = (reactionEvent: ZulipReactionEvent) => {
      const fromEvent = normalizeReactionSourceFromMessage(reactionEvent.message);
      if (fromEvent) {
        reactionMessageContexts.set(reactionEvent.message_id, {
          ...fromEvent,
          capturedAt: Date.now(),
        });
        return fromEvent;
      }

      const cached = reactionMessageContexts.get(reactionEvent.message_id);
      if (!cached) {
        return null;
      }
      if (Date.now() - cached.capturedAt > REACTION_MESSAGE_CONTEXT_TTL_MS) {
        reactionMessageContexts.delete(reactionEvent.message_id);
        return null;
      }
      return { stream: cached.stream, topic: cached.topic };
    };

    const toReactionCommandToken = (emojiName: string) => {
      const normalized = emojiName
        .trim()
        .toLowerCase()
        .replace(/^:/, "")
        .replace(/:$/, "")
        .replace(/[^a-z0-9_+-]+/g, "_")
        .replace(/^_+|_+$/g, "");
      return normalized || "emoji";
    };

    const dispatchSyntheticReactionContext = (params: {
      stream: string;
      topic: string;
      body: string;
      rawBody: string;
      commandBody: string;
      sessionKeySuffix: string;
      userId: number;
      userName: string;
      messageSid: string;
      systemPrompt: string;
      errorLabel: string;
    }) => {
      const target = `stream:${params.stream}#${params.topic}`;
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: params.body,
        RawBody: params.rawBody,
        CommandBody: params.commandBody,
        From: `zulip:user:${params.userId}`,
        To: target,
        SessionKey: `zulip:${account.accountId}:reaction:${params.sessionKeySuffix}`,
        AccountId: account.accountId,
        ChatType: "channel",
        ThreadLabel: params.topic,
        MessageThreadId: params.topic,
        ConversationLabel: `${params.stream}#${params.topic}`,
        GroupSubject: params.stream,
        GroupChannel: `#${params.stream}`,
        GroupSystemPrompt: params.systemPrompt,
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        SenderName: params.userName,
        SenderId: String(params.userId),
        MessageSid: params.messageSid,
        WasMentioned: true,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: target,
        Timestamp: Date.now(),
        CommandAuthorized: true,
      });

      void core.channel.reply
        .dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher: {
            sendToolResult: () => true,
            sendBlockReply: (payload: ReplyPayload) => {
              if (!payload.text) {
                return false;
              }
              void sendZulipStreamMessage({
                auth,
                stream: params.stream,
                topic: params.topic,
                content: payload.text,
                abortSignal,
              });
              return true;
            },
            sendFinalReply: (payload: ReplyPayload) => {
              if (!payload.text) {
                return false;
              }
              void sendZulipStreamMessage({
                auth,
                stream: params.stream,
                topic: params.topic,
                content: payload.text,
                abortSignal,
              });
              return true;
            },
            markComplete: () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            waitForIdle: () => Promise.resolve(),
          },
          replyOptions: {
            disableBlockStreaming: !account.blockStreaming,
          },
        })
        .catch((err: unknown) => {
          logger.error?.(`[zulip] ${params.errorLabel} dispatch failed: ${String(err)}`);
        });
    };

    // Handler for reaction events (reaction buttons + optional generic callbacks)
    const handleReaction = (reactionEvent: ZulipReactionEvent) => {
      if (typeof reactionEvent.message_id !== "number") {
        return;
      }

      const result =
        reactionEvent.op === "add"
          ? handleReactionEvent({
              messageId: reactionEvent.message_id,
              emojiName: reactionEvent.emoji_name,
              userId: reactionEvent.user_id,
              botUserId,
            })
          : null;

      if (result) {
        logger.info(
          `[zulip:${account.accountId}] reaction button clicked: messageId=${result.messageId}, index=${result.selectedIndex}, value=${result.selectedOption?.value}`,
        );

        core.channel.activity.record({
          channel: "zulip",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });

        const buttonSession = getReactionButtonSession(result.messageId);
        const source = buttonSession
          ? { stream: buttonSession.stream, topic: buttonSession.topic }
          : resolveReactionSource(reactionEvent);

        if (!source?.stream || !source.topic) {
          logger.debug?.(
            `[zulip:${account.accountId}] reaction button ignored: unresolved source for message ${result.messageId}`,
          );
          return;
        }

        const buttonPayload = {
          type: "reaction_button_click" as const,
          messageId: result.messageId,
          selectedIndex: result.selectedIndex,
          selectedOption: result.selectedOption,
          userId: reactionEvent.user_id,
          userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
        };

        dispatchSyntheticReactionContext({
          stream: source.stream,
          topic: source.topic,
          body: `[zulip reaction button click: messageId=${result.messageId}, option="${result.selectedOption?.label}" (${result.selectedOption?.value})]`,
          rawBody: JSON.stringify(buttonPayload),
          commandBody: `reaction_button_${result.selectedIndex}`,
          sessionKeySuffix: String(result.messageId),
          userId: reactionEvent.user_id,
          userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
          messageSid: `reaction-button-${result.messageId}-${Date.now()}`,
          systemPrompt:
            "A user clicked a reaction button on a previous message. Respond to their selection.",
          errorLabel: "reaction button",
        });
        return;
      }

      if (!account.reactions.genericCallback.enabled) {
        return;
      }
      if (reactionEvent.user_id === botUserId) {
        return;
      }
      if (reactionEvent.op === "remove" && !account.reactions.genericCallback.includeRemoveOps) {
        return;
      }

      const source = resolveReactionSource(reactionEvent);
      if (!source?.stream || !source.topic) {
        logger.debug?.(
          `[zulip:${account.accountId}] generic reaction ignored: unresolved source for message ${reactionEvent.message_id}`,
        );
        return;
      }

      if (
        account.streams.length > 0 &&
        !isSubscribedMode(account.streams) &&
        !account.streams.includes(source.stream)
      ) {
        return;
      }

      core.channel.activity.record({
        channel: "zulip",
        accountId: account.accountId,
        direction: "inbound",
        at: Date.now(),
      });

      const normalizedEmojiToken = toReactionCommandToken(reactionEvent.emoji_name);
      const genericPayload = {
        type: "reaction_event" as const,
        op: reactionEvent.op,
        emojiName: reactionEvent.emoji_name,
        emojiCode: reactionEvent.emoji_code,
        messageId: reactionEvent.message_id,
        userId: reactionEvent.user_id,
        userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
      };

      dispatchSyntheticReactionContext({
        stream: source.stream,
        topic: source.topic,
        body: `[zulip reaction ${reactionEvent.op}: messageId=${reactionEvent.message_id}, emoji="${reactionEvent.emoji_name}"]`,
        rawBody: JSON.stringify(genericPayload),
        commandBody: `reaction_${reactionEvent.op}_${normalizedEmojiToken}`,
        sessionKeySuffix: `${reactionEvent.message_id}:${reactionEvent.op}:${normalizedEmojiToken}`,
        userId: reactionEvent.user_id,
        userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
        messageSid: `reaction-generic-${reactionEvent.message_id}-${Date.now()}`,
        systemPrompt:
          "A user added or removed a reaction in this topic. Treat this as an inbound signal and respond only if helpful.",
        errorLabel: "generic reaction",
      });
    };

    const replayPendingCheckpoints = async () => {
      const checkpoints = await loadZulipInFlightCheckpoints({ accountId: account.accountId });
      for (const checkpoint of checkpoints) {
        if (resumedCheckpointIds.has(checkpoint.checkpointId)) {
          continue;
        }
        resumedCheckpointIds.add(checkpoint.checkpointId);

        if (checkpoint.retryCount >= ZULIP_INFLIGHT_MAX_RETRY_COUNT) {
          logger.warn(
            `[zulip:${account.accountId}] dropping exhausted in-flight checkpoint ${checkpoint.checkpointId} (retryCount=${checkpoint.retryCount})`,
          );
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
            () => undefined,
          );
          continue;
        }

        if (isZulipCheckpointStale({ checkpoint })) {
          logger.warn(
            `[zulip:${account.accountId}] skipping stale in-flight checkpoint ${checkpoint.checkpointId}`,
          );
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
            () => undefined,
          );
          continue;
        }

        await sendZulipStreamMessage({
          auth,
          stream: checkpoint.stream,
          topic: checkpoint.topic,
          content: ZULIP_RECOVERY_NOTICE,
          abortSignal,
        }).catch((err) => {
          logger.warn(
            `[zulip:${account.accountId}] failed to send recovery notice for ${checkpoint.checkpointId}: ${String(err)}`,
          );
        });

        const syntheticMessage: ZulipEventMessage = {
          id: checkpoint.messageId,
          type: "stream",
          sender_id: Number(checkpoint.senderId) || 0,
          sender_full_name: checkpoint.senderName,
          sender_email: checkpoint.senderEmail,
          display_recipient: checkpoint.stream,
          stream_id: checkpoint.streamId,
          subject: checkpoint.topic,
          content: checkpoint.cleanedContent,
          timestamp:
            typeof checkpoint.timestampMs === "number"
              ? Math.floor(checkpoint.timestampMs / 1000)
              : undefined,
        };

        try {
          await handleMessage(syntheticMessage, { recoveryCheckpoint: checkpoint });
        } catch (err) {
          runtime.error?.(
            `[zulip:${account.accountId}] recovery replay failed for ${checkpoint.checkpointId}: ${String(err)}`,
          );
          const failedCheckpoint = markZulipCheckpointFailure({ checkpoint, error: err });
          await writeZulipInFlightCheckpoint({ checkpoint: failedCheckpoint }).catch(
            () => undefined,
          );
        }
      }
    };

    const pollStreamQueue = async (stream: string, streamAbortSignal?: AbortSignal) => {
      const loopAbortSignal = streamAbortSignal ?? abortSignal;
      let queueId = "";
      let lastEventId = -1;
      let retry = 0;
      let stage: "register" | "poll" | "handle" = "register";

      // Backpressure: limit concurrent message handlers to prevent unbounded pile-up.
      // Set high enough to handle many active topics simultaneously — each handler holds
      // its slot for the full agent turn (which can take 30-120s with Opus + tools).
      // A low limit (e.g. 5) causes messages to queue behind long-running turns.
      const MAX_CONCURRENT_HANDLERS = 20;
      let activeHandlers = 0;
      const handlerWaiters: Array<() => void> = [];

      const throttledHandleMessage = async (msg: ZulipEventMessage) => {
        if (activeHandlers >= MAX_CONCURRENT_HANDLERS) {
          await new Promise<void>((resolve) => handlerWaiters.push(resolve));
        }
        activeHandlers++;
        try {
          await handleMessage(msg);
        } finally {
          activeHandlers--;
          const next = handlerWaiters.shift();
          if (next) next();
        }
      };

      // Freshness checker: periodically verify we haven't missed messages during
      // long-poll gaps, queue re-registrations, or silent connection drops.
      // Fetches the 5 most recent messages via REST and processes any with IDs
      // higher than the last one we saw through the event queue.
      let lastSeenMsgId = 0;
      const FRESHNESS_INTERVAL_MS = 30_000;
      const freshnessTimer = setInterval(async () => {
        if (stopped || loopAbortSignal.aborted || lastSeenMsgId === 0) return;
        try {
          const recent = await zulipRequest<{ result: string; messages?: ZulipEventMessage[] }>({
            auth,
            method: "GET",
            path: "/api/v1/messages",
            query: {
              anchor: "newest",
              num_before: 5,
              num_after: 0,
              narrow: JSON.stringify([["stream", stream]]),
              apply_markdown: "false",
            },
            abortSignal: loopAbortSignal,
          });
          if (recent.result === "success" && recent.messages) {
            let caught = 0;
            for (const msg of recent.messages) {
              if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                caught++;
                lastSeenMsgId = msg.id;
                throttledHandleMessage(msg).catch((err) => {
                  runtime.error?.(`zulip: freshness catchup failed: ${String(err)}`);
                });
              }
            }
            if (caught > 0) {
              logger.warn(
                `[zulip:${account.accountId}] freshness checker recovered ${caught} missed message(s) in stream "${stream}"`,
              );
            }
          }
        } catch {
          // Best effort — freshness check is non-critical.
        }
      }, FRESHNESS_INTERVAL_MS);

      while (!stopped && !loopAbortSignal.aborted) {
        try {
          if (!queueId) {
            stage = "register";
            const wasReregistration = lastEventId !== -1;
            const reg = await registerQueue({ auth, stream, abortSignal: loopAbortSignal });
            queueId = reg.queueId;
            lastEventId = reg.lastEventId;

            // Issue 5: recover messages lost during queue gap on re-registration.
            if (wasReregistration) {
              try {
                const recent = await zulipRequest<{
                  result: string;
                  messages?: ZulipEventMessage[];
                }>({
                  auth,
                  method: "GET",
                  path: "/api/v1/messages",
                  query: {
                    anchor: "newest",
                    num_before: 10,
                    num_after: 0,
                    narrow: JSON.stringify([["stream", stream]]),
                    apply_markdown: "false",
                  },
                  abortSignal: loopAbortSignal,
                });
                if (recent.result === "success" && recent.messages) {
                  for (const msg of recent.messages) {
                    // Track highest ID for freshness checker.
                    if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                      lastSeenMsgId = msg.id;
                    }
                    // dedupe.check skips already-processed messages
                    throttledHandleMessage(msg).catch((err) => {
                      runtime.error?.(`zulip: catchup message failed: ${String(err)}`);
                    });
                  }
                }
              } catch (catchupErr) {
                logger.debug?.(
                  `[zulip:${account.accountId}] catchup fetch failed: ${String(catchupErr)}`,
                );
              }
            }
          }

          stage = "poll";
          logger.warn(
            `[zulip-debug][${account.accountId}] polling events (queue=${queueId.slice(0, 8)}, lastEventId=${lastEventId}, stream=${stream})`,
          );
          const events = await pollEvents({ auth, queueId, lastEventId, abortSignal: loopAbortSignal });
          if (events.result !== "success") {
            throw new Error(events.msg || "Zulip events poll failed");
          }

          const list = events.events ?? [];
          // Update lastEventId from individual event IDs. The /api/v1/events
          // response does NOT include a top-level last_event_id field — only
          // /api/v1/register does. Without this, lastEventId stays at -1 forever,
          // causing every poll to replay ALL events since queue registration.
          for (const evt of list) {
            if (typeof evt.id === "number" && evt.id > lastEventId) {
              lastEventId = evt.id;
            }
          }

          logger.warn(
            `[zulip-debug][${account.accountId}] poll returned ${list.length} events (messages: ${list.filter((e) => e.message).length}, lastEventId=${lastEventId})`,
          );

          for (const evt of list) {
            const rename = parseTopicRenameEvent(evt);
            if (!rename) {
              continue;
            }
            const mapped = recordTopicRenameAlias({
              aliasesByStream: topicAliasesByStream,
              stream,
              fromTopic: rename.fromTopic,
              toTopic: rename.toTopic,
            });
            if (mapped) {
              logger.info(
                `[zulip:${account.accountId}] mapped topic rename alias for stream "${stream}": "${rename.toTopic}" -> "${rename.fromTopic}"`,
              );
            }
          }

          const messages = list
            .map((evt) => evt.message)
            .filter((m): m is ZulipEventMessage => Boolean(m));

          for (const msg of messages) {
            rememberReactionMessageContext(msg);
          }

          // Track highest message ID for freshness checker gap detection.
          for (const msg of messages) {
            if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
              lastSeenMsgId = msg.id;
            }
          }

          for (const msg of messages) {
            const ignore = shouldIgnoreMessage({
              message: msg,
              botUserId,
              streams: account.streams,
            });
            logger.warn(
              `[zulip-debug][${account.accountId}] event msg id=${msg.id} topic="${msg.subject}" sender=${msg.sender_id} ignore=${ignore.ignore}${ignore.reason ? ` (${ignore.reason})` : ""}`,
            );
          }

          // Handle reaction events
          const reactionEvents = list
            .filter((evt): evt is ZulipEvent & ZulipReactionEvent => evt.type === "reaction")
            .map((evt) => evt as ZulipReactionEvent);

          for (const reactionEvent of reactionEvents) {
            try {
              handleReaction(reactionEvent);
            } catch (err) {
              logger.debug?.(
                `[zulip:${account.accountId}] reaction handling failed: ${String(err)}`,
              );
            }
          }

          // Defensive throttle: if Zulip responds immediately without any message payloads (e.g.
          // heartbeat-only events, proxies, or aggressive server settings), avoid a tight loop that can
          // hit 429s.
          if (messages.length === 0 && reactionEvents.length === 0) {
            const jitterMs = Math.floor(Math.random() * 250);
            await sleep(2000 + jitterMs, loopAbortSignal).catch(() => undefined);
            retry = 0;
            continue;
          }

          stage = "handle";
          for (const msg of messages) {
            // Use throttled handler with backpressure (max concurrent limit)
            throttledHandleMessage(msg).catch((err) => {
              runtime.error?.(`zulip: message processing failed: ${String(err)}`);
            });
            // Small stagger between starting each message for natural pacing
            await sleep(200, loopAbortSignal).catch(() => undefined);
          }

          retry = 0;
        } catch (err) {
          // FIX: Only break if explicitly stopped, NOT on abort
          // Abort errors (timeouts) should trigger queue re-registration
            if (stopped || loopAbortSignal.aborted) {
              break;
            }

          const status = extractZulipHttpStatus(err);
          const retryAfterMs = (err as ZulipHttpError).retryAfterMs;

          // FIX: Always clear queueId on ANY error to force re-registration
          // This prevents stuck queues when fetch times out or aborts
          queueId = "";

          // Detect timeout/abort errors specifically for better logging
          const isAbortError =
            err instanceof Error &&
            (err.name === "AbortError" ||
              err.message?.includes("aborted") ||
              err.message?.includes("timeout") ||
              err.message?.includes("ETIMEDOUT"));

          if (isAbortError) {
            logger.warn(
              `[zulip:${account.accountId}] poll timeout/abort detected (stream=${stream}, stage=${stage}): ${String(err)} - forcing queue re-registration`,
            );
          }

          retry += 1;
          const backoffMs = computeZulipMonitorBackoffMs({
            attempt: retry,
            status,
            retryAfterMs,
          });
          logger.warn(
            `[zulip:${account.accountId}] monitor error (stream=${stream}, stage=${stage}, attempt=${retry}): ${String(err)} (retry in ${backoffMs}ms)`,
          );
          await sleep(backoffMs, loopAbortSignal).catch(() => undefined);
        }
      }

      // Clean up freshness checker interval.
      clearInterval(freshnessTimer);

      // Issue 4: clean up the server-side event queue on shutdown.
      if (queueId) {
        try {
          await zulipRequest({
            auth,
            method: "DELETE",
            path: "/api/v1/events",
            form: { queue_id: queueId },
          });
        } catch {
          // Best effort — server will expire it anyway.
        }
      }
    };

    await replayPendingCheckpoints();

    // Clean up stale status messages from previous session.
    {
      const streamsToClean = isSubscribedMode(account.streams)
        ? await fetchSubscribedStreams({ auth, abortSignal })
        : account.streams;
      await cleanupStaleStatusMessages({
        auth,
        streams: streamsToClean,
        fetchMessages: fetchBotMessagesForStream,
        deleteMessage: deleteBotMessage,
        maxPerStream: 500,
        logger,
      });
    }

    if (!isSubscribedMode(account.streams)) {
      const plan = buildZulipQueuePlan(account.streams);
      if (plan.length === 0) {
        throw new Error(
          `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
        );
      }
      await Promise.all(plan.map((entry) => pollStreamQueue(entry.stream)));
      return;
    }

    logger.info(
      `[zulip:${account.accountId}] dynamic stream mode active (${SUBSCRIBED_TOKEN}) - monitoring all subscribed channels`,
    );

    const activeStreamPolls = new Map<
      string,
      {
        abort: AbortController;
        done: Promise<void>;
      }
    >();

    const startStreamPoll = (stream: string) => {
      const normalized = normalizeStreamName(stream);
      if (!normalized || activeStreamPolls.has(normalized)) {
        return;
      }
      const streamAbort = new AbortController();
      const onParentAbort = () => streamAbort.abort();
      abortSignal.addEventListener("abort", onParentAbort, { once: true });
      const done = pollStreamQueue(normalized, streamAbort.signal).finally(() => {
        abortSignal.removeEventListener("abort", onParentAbort);
        activeStreamPolls.delete(normalized);
      });
      activeStreamPolls.set(normalized, { abort: streamAbort, done });
      logger.info(`[zulip:${account.accountId}] now monitoring stream "${normalized}"`);
    };

    const stopStreamPoll = (stream: string) => {
      const normalized = normalizeStreamName(stream);
      if (!normalized) {
        return;
      }
      const active = activeStreamPolls.get(normalized);
      if (!active) {
        return;
      }
      active.abort.abort();
      logger.info(`[zulip:${account.accountId}] stopped monitoring stream "${normalized}"`);
    };

    const initialStreams = await fetchSubscribedStreams({ auth, abortSignal });
    for (const stream of initialStreams) {
      startStreamPoll(stream);
    }
    logger.info(
      `[zulip:${account.accountId}] initialized ${initialStreams.length} subscribed stream poll(s)`,
    );

    let watcherQueueId = "";
    let watcherLastEventId = -1;
    let watcherRetry = 0;

    while (!stopped && !abortSignal.aborted) {
      try {
        if (!watcherQueueId) {
          const reg = await registerQueue({
            auth,
            eventTypes: ["subscription"],
            abortSignal,
          });
          watcherQueueId = reg.queueId;
          watcherLastEventId = reg.lastEventId;
          watcherRetry = 0;
          logger.info(`[zulip:${account.accountId}] subscription watcher registered`);
        }

        const events = await pollEvents({
          auth,
          queueId: watcherQueueId,
          lastEventId: watcherLastEventId,
          abortSignal,
        });
        if (events.result !== "success") {
          throw new Error(events.msg || "Zulip subscription poll failed");
        }
        const list = events.events ?? [];
        for (const evt of list) {
          if (typeof evt.id === "number" && evt.id > watcherLastEventId) {
            watcherLastEventId = evt.id;
          }

          if (evt.type !== "subscription") {
            continue;
          }

          const subEvt = evt as ZulipSubscriptionEvent;
          const streams = extractSubscribedStreamNames(subEvt);
          if (subEvt.op === "add") {
            for (const stream of streams) {
              startStreamPoll(stream);
            }
          } else if (subEvt.op === "remove") {
            for (const stream of streams) {
              stopStreamPoll(stream);
            }
          }
        }

        if (list.length === 0) {
          await sleep(1500, abortSignal).catch(() => undefined);
        }
      } catch (err) {
        if (stopped || abortSignal.aborted) {
          break;
        }
        if (watcherQueueId) {
          await zulipRequest({
            auth,
            method: "DELETE",
            path: "/api/v1/events",
            form: { queue_id: watcherQueueId },
          }).catch(() => undefined);
          watcherQueueId = "";
        }
        watcherRetry += 1;
        const backoffMs = computeZulipMonitorBackoffMs({
          attempt: watcherRetry,
          status: null,
        });
        logger.warn(
          `[zulip:${account.accountId}] subscription watcher error (attempt=${watcherRetry}): ${String(err)} (retry in ${backoffMs}ms)`,
        );
        await sleep(backoffMs, abortSignal).catch(() => undefined);
      }
    }

    for (const active of activeStreamPolls.values()) {
      active.abort.abort();
    }
    await Promise.allSettled(Array.from(activeStreamPolls.values()).map((entry) => entry.done));

    if (watcherQueueId) {
      await zulipRequest({
        auth,
        method: "DELETE",
        path: "/api/v1/events",
        form: { queue_id: watcherQueueId },
      }).catch(() => undefined);
    }
  };

  const done = run()
    .catch((err) => {
      if (abortSignal.aborted || stopped) {
        return;
      }
      opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
      runtime.error?.(`[zulip:${account.accountId}] monitor crashed: ${String(err)}`);
    })
    .finally(() => {
      // Clean up reaction button sessions
      stopReactionButtonSessionCleanup();
      logger.warn(`[zulip-debug][${account.accountId}] stopped`);
    });

  return { stop, done };
}
