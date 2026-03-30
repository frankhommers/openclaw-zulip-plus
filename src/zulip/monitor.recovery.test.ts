import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReplyPrefixOptions: vi.fn(),
  getZulipRuntime: vi.fn(),
  resolveZulipAccount: vi.fn(),
  zulipRequest: vi.fn(),
  sendZulipStreamMessage: vi.fn(),
  downloadZulipUploads: vi.fn(),
  resolveOutboundMedia: vi.fn(),
  uploadZulipFile: vi.fn(),
  addZulipReaction: vi.fn(),
  removeZulipReaction: vi.fn(),
  buildZulipQueuePlan: vi.fn(),
  buildZulipRegisterNarrow: vi.fn(),
  loadZulipInFlightCheckpoints: vi.fn(),
  writeZulipInFlightCheckpoint: vi.fn(),
  clearZulipInFlightCheckpoint: vi.fn(),
  isZulipCheckpointStale: vi.fn(),
  prepareZulipCheckpointForRecovery: vi.fn(),
  markZulipCheckpointFailure: vi.fn(),
  buildZulipCheckpointId: vi.fn(),
  loadZulipProcessedMessageState: vi.fn(),
  isZulipMessageProcessed: vi.fn(),
  markZulipMessageProcessed: vi.fn(),
  writeZulipProcessedMessageState: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk")>();
  return {
    ...actual,
    createReplyPrefixOptions: mocks.createReplyPrefixOptions,
  };
});

vi.mock("../runtime.js", () => ({
  getZulipRuntime: mocks.getZulipRuntime,
}));

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: mocks.resolveZulipAccount,
}));

vi.mock("./client.js", () => ({
  zulipRequest: mocks.zulipRequest,
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: mocks.sendZulipStreamMessage,
  editZulipStreamMessage: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./uploads.js", () => ({
  downloadZulipUploads: mocks.downloadZulipUploads,
  resolveOutboundMedia: mocks.resolveOutboundMedia,
  uploadZulipFile: mocks.uploadZulipFile,
}));

vi.mock("./reactions.js", () => ({
  addZulipReaction: mocks.addZulipReaction,
  removeZulipReaction: mocks.removeZulipReaction,
}));

vi.mock("./queue-plan.js", () => ({
  buildZulipQueuePlan: mocks.buildZulipQueuePlan,
  buildZulipRegisterNarrow: mocks.buildZulipRegisterNarrow,
}));

vi.mock("./inflight-checkpoints.js", () => ({
  ZULIP_INFLIGHT_CHECKPOINT_VERSION: 1,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT: 25,
  loadZulipInFlightCheckpoints: mocks.loadZulipInFlightCheckpoints,
  writeZulipInFlightCheckpoint: mocks.writeZulipInFlightCheckpoint,
  clearZulipInFlightCheckpoint: mocks.clearZulipInFlightCheckpoint,
  isZulipCheckpointStale: mocks.isZulipCheckpointStale,
  prepareZulipCheckpointForRecovery: mocks.prepareZulipCheckpointForRecovery,
  markZulipCheckpointFailure: mocks.markZulipCheckpointFailure,
  buildZulipCheckpointId: mocks.buildZulipCheckpointId,
}));

vi.mock("./processed-message-state.js", () => ({
  loadZulipProcessedMessageState: mocks.loadZulipProcessedMessageState,
  isZulipMessageProcessed: mocks.isZulipMessageProcessed,
  markZulipMessageProcessed: mocks.markZulipMessageProcessed,
  writeZulipProcessedMessageState: mocks.writeZulipProcessedMessageState,
}));

import { monitorZulipProvider, ZULIP_RECOVERY_NOTICE } from "./monitor.js";

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
  timestamp?: number;
};

type ZulipReactionHarnessEvent = {
  type: "reaction";
  op: "add" | "remove";
  message_id: number;
  emoji_name: string;
  emoji_code: string;
  user_id: number;
  user?: {
    full_name?: string;
  };
  message?: {
    type?: string;
    display_recipient?: string;
    subject?: string;
  };
};

type ZulipHarnessEvent = ZulipEventMessage | ZulipReactionHarnessEvent;

type ThreadHistoryMessage = {
  id: number;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  content?: string;
  timestamp?: number;
};

function getDispatchCall(
  dispatchReplyFromConfig: ReturnType<typeof vi.fn>,
  index: number,
): { ctx?: Record<string, unknown> } | undefined {
  const calls = dispatchReplyFromConfig.mock.calls as Array<[unknown]>;
  const entry = calls[index];
  if (!entry) {
    return undefined;
  }
  return entry[0] as { ctx?: Record<string, unknown> };
}

function makeCheckpoint(overrides?: Partial<Record<string, unknown>>) {
  const base = {
    version: 1,
    checkpointId: "default:5001",
    accountId: "default",
    stream: "marcel",
    topic: "general",
    messageId: 5001,
    senderId: "55",
    senderName: "Tester",
    senderEmail: "tester@example.com",
    cleanedContent: "hello",
    body: "hello\n[zulip message id: 5001 stream: marcel topic: general]",
    sessionKey: "session-key:topic:general",
    from: "zulip:channel:marcel",
    to: "stream:marcel#general",
    wasMentioned: false,
    streamId: 42,
    timestampMs: Date.now(),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    retryCount: 0,
  };
  return { ...base, ...(overrides ?? {}) };
}

function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("condition timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createHarness(params?: {
  events?: ZulipHarnessEvent[];
  checkpoints?: Array<Record<string, unknown>>;
  staleCheckpoints?: boolean;
  reactions?: Record<string, unknown>;
  personaRouting?: Array<{ stream?: string; topic?: string; personaFile?: string }>;
  recentTopicMessages?: ThreadHistoryMessage[];
  recentTopicMessagesByNarrow?: Record<string, ThreadHistoryMessage[]>;
}) {
  const dispatchReplyFromConfig = vi.fn(async () => undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  const dispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => undefined),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };

  const runtime = {
    logging: {
      getChildLogger: vi.fn(() => logger),
    },
    channel: {
      text: {
        chunkMarkdownText: vi.fn((value: string) => [value]),
      },
      activity: {
        record: vi.fn(),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "session-key",
          agentId: "agent-1",
          accountId: "acc-1",
        })),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
      reply: {
        formatInboundEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext: vi.fn((ctx: object) => ctx),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher,
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        resolveHumanDelayConfig: vi.fn(() => ({ mode: "off" })),
        dispatchReplyFromConfig,
      },
    },
    config: {
      loadConfig: vi.fn(() => ({})),
    },
  };

  mocks.getZulipRuntime.mockReturnValue(runtime);
  mocks.createReplyPrefixOptions.mockReturnValue({ onModelSelected: undefined });

  const defaultReactions = {
    enabled: false,
    onStart: "eyes",
    onSuccess: "check",
    onFailure: "warning",
    clearOnFinish: true,
    genericCallback: {
      enabled: false,
      includeRemoveOps: false,
    },
    workflow: {
      enabled: false,
      replaceStageReaction: false,
      minTransitionMs: 0,
      stages: {
        queued: "",
        processing: "",
        toolRunning: "",
        retrying: "",
        success: "check",
        partialSuccess: "warning",
        failure: "warning",
      },
    },
  };
  const customReactions = (params?.reactions ?? {}) as Record<string, unknown>;

  mocks.resolveZulipAccount.mockReturnValue({
    accountId: "default",
    baseUrl: "https://zulip.example.com",
    email: "bot@zulip.example.com",
    apiKey: "api-key",
    streams: ["marcel"],
    allowBotIds: [],
    botLoopPrevention: {
      maxChainLength: 3,
      cooldownMs: 30_000,
    },
    chatmode: "all",
    blockStreaming: true,
    showThinking: { mode: "none", debounceMs: 1500 },
    defaultTopic: "general",
    alwaysReply: true,
    textChunkLimit: 10_000,
    config: {
      personaRouting: params?.personaRouting ?? [],
    },
    workingMessages: {
      enabled: false,
    },
    processingSpinner: {
      enabled: false,
      emoji: [],
      intervalMs: 10_000,
    },
    reactions: {
      ...defaultReactions,
      ...customReactions,
      genericCallback: {
        ...defaultReactions.genericCallback,
        ...((customReactions.genericCallback as Record<string, unknown> | undefined) ?? {}),
      },
      workflow: {
        ...defaultReactions.workflow,
        ...((customReactions.workflow as Record<string, unknown> | undefined) ?? {}),
        stages: {
          ...defaultReactions.workflow.stages,
          ...((
            (customReactions.workflow as { stages?: Record<string, unknown> } | undefined)?.stages ?? {}
          ) as Record<string, unknown>),
        },
      },
    },
  });

  mocks.buildZulipQueuePlan.mockReturnValue([{ stream: "marcel" }]);
  mocks.buildZulipRegisterNarrow.mockReturnValue(JSON.stringify([["stream", "marcel"]]));
  mocks.downloadZulipUploads.mockResolvedValue([]);
  mocks.resolveOutboundMedia.mockResolvedValue({
    buffer: Buffer.from(""),
    contentType: "image/png",
    filename: "x.png",
  });
  mocks.uploadZulipFile.mockResolvedValue("https://zulip.example.com/user_uploads/file.png");
  mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 991 });

  const checkpoints = params?.checkpoints ?? [];
  mocks.loadZulipInFlightCheckpoints.mockResolvedValue(checkpoints);
  mocks.isZulipCheckpointStale.mockReturnValue(Boolean(params?.staleCheckpoints));
  mocks.prepareZulipCheckpointForRecovery.mockImplementation(
    ({ checkpoint }: { checkpoint: Record<string, unknown> }) => ({
      ...checkpoint,
      retryCount: Number(checkpoint.retryCount ?? 0) + 1,
    }),
  );
  mocks.markZulipCheckpointFailure.mockImplementation(
    ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
  );
  mocks.buildZulipCheckpointId.mockImplementation(
    ({ accountId, messageId }: { accountId: string; messageId: number }) =>
      `${accountId}:${messageId}`,
  );
  mocks.loadZulipProcessedMessageState.mockResolvedValue({
    version: 1,
    watermarks: {},
  });
  mocks.isZulipMessageProcessed.mockReturnValue(false);
  mocks.markZulipMessageProcessed.mockReturnValue(true);
  mocks.writeZulipProcessedMessageState.mockResolvedValue(undefined);

  let pollCount = 0;
  const eventList = params?.events ?? [];

  mocks.zulipRequest.mockImplementation(
    async ({
      path,
      method,
      query,
      abortSignal,
    }: {
      path: string;
      method?: string;
      query?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }) => {
      if (path === "/api/v1/users/me") {
        return { result: "success", user_id: 9 };
      }
      if (path === "/api/v1/register") {
        return { result: "success", queue_id: "queue-1", last_event_id: 100 };
      }
      if (path === "/api/v1/events" && method === "DELETE") {
        return { result: "success" };
      }
      if (path === "/api/v1/events") {
        pollCount += 1;
        if (pollCount === 1 && eventList.length > 0) {
          return {
            result: "success",
            events: eventList.map((event, index) => {
              if (event.type === "reaction") {
                return { id: 101 + index, ...event };
              }
              return { id: 101 + index, message: event };
            }),
          };
        }
        return await new Promise<never>((_, reject) => {
          const onAbort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (abortSignal?.aborted) {
            onAbort();
            return;
          }
          abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (path === "/api/v1/typing") {
        return { result: "success" };
      }
      if (path === "/api/v1/messages") {
        const narrow = typeof query?.narrow === "string" ? query.narrow : "";
        const hasTopicNarrow = narrow.includes('"topic"');
        if (hasTopicNarrow) {
          if (params?.recentTopicMessagesByNarrow?.[narrow]) {
            return {
              result: "success",
              messages: params.recentTopicMessagesByNarrow[narrow],
            };
          }
          return {
            result: "success",
            messages: params?.recentTopicMessages ?? [],
          };
        }
        return {
          result: "success",
          messages: [],
        };
      }
      return { result: "success" };
    },
  );

  return { dispatchReplyFromConfig };
}

describe("monitorZulipProvider recovery checkpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes then clears the replayed in-flight checkpoint on success", async () => {
    const checkpoint = makeCheckpoint();
    const { dispatchReplyFromConfig } = createHarness({ checkpoints: [checkpoint] });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);
    await waitForCondition(() => mocks.writeZulipInFlightCheckpoint.mock.calls.length > 0);
    await waitForCondition(() => mocks.clearZulipInFlightCheckpoint.mock.calls.length > 0);

    expect(mocks.writeZulipInFlightCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          checkpointId: checkpoint.checkpointId,
          accountId: checkpoint.accountId,
          messageId: checkpoint.messageId,
          stream: checkpoint.stream,
          topic: checkpoint.topic,
        }),
      }),
    );
    expect(mocks.clearZulipInFlightCheckpoint).toHaveBeenCalledWith({
      checkpointId: checkpoint.checkpointId,
    });

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("replays pending checkpoint on startup and sends one recovery notice", async () => {
    const checkpoint = makeCheckpoint();
    const { dispatchReplyFromConfig } = createHarness({ checkpoints: [checkpoint] });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: checkpoint.stream,
        topic: checkpoint.topic,
        content: ZULIP_RECOVERY_NOTICE,
      }),
    );

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("supports workflow-stage reactions when enabled", async () => {
    const event: ZulipEventMessage = {
      id: 6001,
      type: "stream",
      sender_id: 55,
      sender_full_name: "Tester",
      display_recipient: "marcel",
      stream_id: 42,
      subject: "general",
      content: "hello",
      timestamp: Math.floor(Date.now() / 1000),
    };

    const { dispatchReplyFromConfig } = createHarness({
      events: [event],
      reactions: {
        enabled: true,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        clearOnFinish: true,
        workflow: {
          enabled: true,
          replaceStageReaction: true,
          minTransitionMs: 0,
          stages: {
            queued: "hourglass",
            processing: "gear",
            success: "check",
            partialSuccess: "construction",
            failure: "warning",
          },
        },
      },
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);
    await waitForCondition(() => mocks.addZulipReaction.mock.calls.length >= 3);

    const addedEmojis = mocks.addZulipReaction.mock.calls.map(
      ([arg]) => (arg as { emojiName: string }).emojiName,
    );
    const removedEmojis = mocks.removeZulipReaction.mock.calls.map(
      ([arg]) => (arg as { emojiName: string }).emojiName,
    );

    expect(addedEmojis).toEqual(["hourglass", "gear", "check"]);
    expect(removedEmojis).toEqual(["hourglass", "gear"]);

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("keeps generic reaction callbacks disabled by default", async () => {
    const { dispatchReplyFromConfig } = createHarness({
      events: [
        {
          type: "reaction",
          op: "add",
          message_id: 7001,
          emoji_name: "fire",
          emoji_code: "1f525",
          user_id: 55,
          user: { full_name: "Tester" },
          message: {
            type: "stream",
            display_recipient: "marcel",
            subject: "general",
          },
        },
      ],
      reactions: {
        enabled: false,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        clearOnFinish: true,
        genericCallback: {
          enabled: false,
          includeRemoveOps: false,
        },
      },
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() =>
      mocks.zulipRequest.mock.calls.some(
        ([arg]) => (arg as { path?: string }).path === "/api/v1/events",
      ),
    );

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("dispatches synthetic inbound context for generic reactions when enabled", async () => {
    const { dispatchReplyFromConfig } = createHarness({
      events: [
        {
          type: "reaction",
          op: "add",
          message_id: 7002,
          emoji_name: "fire",
          emoji_code: "1f525",
          user_id: 55,
          user: { full_name: "Tester" },
          message: {
            type: "stream",
            display_recipient: "marcel",
            subject: "general",
          },
        },
      ],
      reactions: {
        enabled: false,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        clearOnFinish: true,
        genericCallback: {
          enabled: true,
          includeRemoveOps: false,
        },
      },
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

    const call = getDispatchCall(dispatchReplyFromConfig, 0);
    expect(call?.ctx).toMatchObject({
      CommandBody: "reaction_add_fire",
      To: "stream:marcel#general",
      SenderId: "55",
    });

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("ignores generic reaction remove events unless explicitly enabled", async () => {
    const { dispatchReplyFromConfig } = createHarness({
      events: [
        {
          type: "reaction",
          op: "remove",
          message_id: 7003,
          emoji_name: "fire",
          emoji_code: "1f525",
          user_id: 55,
          user: { full_name: "Tester" },
          message: {
            type: "stream",
            display_recipient: "marcel",
            subject: "general",
          },
        },
      ],
      reactions: {
        enabled: false,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        clearOnFinish: true,
        genericCallback: {
          enabled: true,
          includeRemoveOps: false,
        },
      },
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() =>
      mocks.zulipRequest.mock.calls.some(
        ([arg]) => (arg as { path?: string }).path === "/api/v1/events",
      ),
    );

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("skips stale checkpoints", async () => {
    const checkpoint = makeCheckpoint();
    const { dispatchReplyFromConfig } = createHarness({
      checkpoints: [checkpoint],
      staleCheckpoints: true,
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => mocks.clearZulipInFlightCheckpoint.mock.calls.length > 0);

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.clearZulipInFlightCheckpoint).toHaveBeenCalledWith({
      checkpointId: checkpoint.checkpointId,
    });

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("drops exhausted checkpoints that exceeded retry budget", async () => {
    const checkpoint = makeCheckpoint({ retryCount: 25 });
    const { dispatchReplyFromConfig } = createHarness({ checkpoints: [checkpoint] });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => mocks.clearZulipInFlightCheckpoint.mock.calls.length > 0);

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.clearZulipInFlightCheckpoint).toHaveBeenCalledWith({
      checkpointId: checkpoint.checkpointId,
    });

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("does not replay duplicate checkpoints more than once in one process", async () => {
    const checkpoint = makeCheckpoint();
    const { dispatchReplyFromConfig } = createHarness({
      checkpoints: [checkpoint, checkpoint],
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const recoveryNoticeCalls = mocks.sendZulipStreamMessage.mock.calls.filter(
      ([arg]) => (arg as { content?: string }).content === ZULIP_RECOVERY_NOTICE,
    );
    expect(recoveryNoticeCalls).toHaveLength(1);

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("skips recovery replay when durable watermark already covers the checkpoint message", async () => {
    const checkpoint = makeCheckpoint({ messageId: 9001, checkpointId: "default:9001" });

    const { dispatchReplyFromConfig } = createHarness({ checkpoints: [checkpoint] });
    mocks.loadZulipProcessedMessageState.mockResolvedValue({
      version: 1,
      watermarks: {
        default: {
          marcel: 9001,
        },
      },
    });
    mocks.isZulipMessageProcessed.mockImplementation(
      ({ messageId }: { messageId: number }) => messageId <= 9001,
    );
    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => mocks.clearZulipInFlightCheckpoint.mock.calls.length > 0);

    const recoveryNoticeCalls = mocks.sendZulipStreamMessage.mock.calls.filter(
      ([arg]) => (arg as { content?: string }).content === ZULIP_RECOVERY_NOTICE,
    );
    expect(recoveryNoticeCalls).toHaveLength(0);
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.clearZulipInFlightCheckpoint).toHaveBeenCalledWith({
      checkpointId: checkpoint.checkpointId,
    });

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("fetches recent thread context and includes it in dispatch payload", async () => {
    const event: ZulipEventMessage = {
      id: 9100,
      type: "stream",
      sender_id: 55,
      sender_full_name: "Tester",
      display_recipient: "marcel",
      stream_id: 42,
      subject: "general",
      content: "current request",
      timestamp: Math.floor(Date.now() / 1000),
    };
    const { dispatchReplyFromConfig } = createHarness({
      events: [event],
      recentTopicMessages: [
        {
          id: 9098,
          sender_id: 77,
          sender_full_name: "Alice",
          content: "earlier context one",
          timestamp: Math.floor(Date.now() / 1000) - 90,
        },
        {
          id: 9099,
          sender_id: 78,
          sender_full_name: "Bob",
          content: "earlier context two",
          timestamp: Math.floor(Date.now() / 1000) - 60,
        },
      ],
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

    const firstCall = getDispatchCall(dispatchReplyFromConfig, 0) as
      | { ctx?: { ThreadContext?: string; ThreadContextMessages?: Array<{ id: number }> } }
      | undefined;
    if (!firstCall) {
      throw new Error("expected first dispatch call");
    }

    expect(firstCall.ctx?.ThreadContext).toContain("earlier context one");
    expect(firstCall.ctx?.ThreadContext).toContain("earlier context two");
    expect(firstCall.ctx?.ThreadContextMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 9098 }),
        expect.objectContaining({ id: 9099 }),
      ]),
    );

    expect(mocks.zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/v1/messages",
        query: expect.objectContaining({
          narrow: expect.stringContaining('"topic","general"'),
        }),
      }),
    );

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("keeps bounded per-channel thread history in dispatch context", async () => {
    const events: ZulipEventMessage[] = Array.from({ length: 15 }, (_, index) => ({
      id: 9200 + index,
      type: "stream",
      sender_id: 55,
      sender_full_name: "Tester",
      display_recipient: "marcel",
      stream_id: 42,
      subject: "general",
      content: `message-${index}`,
      timestamp: Math.floor(Date.now() / 1000) + index,
    }));

    const { dispatchReplyFromConfig } = createHarness({ events });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 15, 5_000);

    const calls = dispatchReplyFromConfig.mock.calls as unknown as Array<[unknown]>;
    const finalCallEntry = calls.find(
      ([payload]) =>
        (payload as { ctx?: { MessageSid?: string } }).ctx?.MessageSid === String(events[14].id),
    );
    const finalCall = (finalCallEntry?.[0] as
      | {
          ctx?: {
            ThreadContext?: string;
            ThreadContextMessages?: Array<{ id: number; text?: string }>;
          };
        }
      | undefined);
    if (!finalCall) {
      throw new Error("expected final dispatch call");
    }

    const threadMessages = finalCall.ctx?.ThreadContextMessages ?? [];
    expect(threadMessages.length).toBeGreaterThan(0);
    expect(threadMessages.length).toBeLessThanOrEqual(8);
    expect(finalCall.ctx?.ThreadContext).toContain("message-13");
    expect(finalCall.ctx?.ThreadContext).not.toContain("message-0");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("injects stream/topic persona content before the main user message", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-persona-test-"));
    const personaPath = path.join(tmpDir, "oncall-persona.txt");
    await fs.writeFile(personaPath, "[persona] Respond as SRE lead.", "utf8");

    try {
      const event: ZulipEventMessage = {
        id: 9300,
        type: "stream",
        sender_id: 55,
        sender_full_name: "Tester",
        display_recipient: "marcel",
        stream_id: 42,
        subject: "incidents",
        content: "investigate latest alert",
        timestamp: Math.floor(Date.now() / 1000),
      };

      const { dispatchReplyFromConfig } = createHarness({
        events: [event],
        personaRouting: [
          {
            stream: "marcel",
            topic: "incidents",
            personaFile: personaPath,
          },
        ],
      });

      const monitor = await monitorZulipProvider({
        config: {} as never,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        },
      });

      await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

      const firstCall = getDispatchCall(dispatchReplyFromConfig, 0);
      const body = String(firstCall?.ctx?.Body ?? "");
      expect(body).toContain("[persona] Respond as SRE lead.");
      expect(body.indexOf("[persona] Respond as SRE lead.")).toBeLessThan(
        body.indexOf("investigate latest alert"),
      );

      monitor.stop();
      await (monitor as { done: Promise<void> }).done;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("continues normally when configured persona file is missing", async () => {
    const event: ZulipEventMessage = {
      id: 9301,
      type: "stream",
      sender_id: 55,
      sender_full_name: "Tester",
      display_recipient: "marcel",
      stream_id: 42,
      subject: "incidents",
      content: "no persona file should still dispatch",
      timestamp: Math.floor(Date.now() / 1000),
    };

    const { dispatchReplyFromConfig } = createHarness({
      events: [event],
      personaRouting: [
        {
          stream: "marcel",
          topic: "incidents",
          personaFile: "/definitely/missing/persona.txt",
        },
      ],
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

    const firstCall = getDispatchCall(dispatchReplyFromConfig, 0);
    expect(String(firstCall?.ctx?.Body ?? "")).toContain("no persona file should still dispatch");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("prefers a stream+topic persona route over a broader stream route", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-persona-priority-"));
    const broadPersonaPath = path.join(tmpDir, "broad.txt");
    const specificPersonaPath = path.join(tmpDir, "specific.txt");
    await fs.writeFile(broadPersonaPath, "[persona] Broad stream persona.", "utf8");
    await fs.writeFile(specificPersonaPath, "[persona] Specific incident persona.", "utf8");

    try {
      const event: ZulipEventMessage = {
        id: 9302,
        type: "stream",
        sender_id: 55,
        sender_full_name: "Tester",
        display_recipient: "marcel",
        stream_id: 42,
        subject: "incidents",
        content: "investigate this one first",
        timestamp: Math.floor(Date.now() / 1000),
      };

      const { dispatchReplyFromConfig } = createHarness({
        events: [event],
        personaRouting: [
          { stream: "marcel", personaFile: broadPersonaPath },
          { stream: "marcel", topic: "incidents", personaFile: specificPersonaPath },
        ],
      });

      const monitor = await monitorZulipProvider({
        config: {} as never,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });

      await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length > 0);

      const firstCall = getDispatchCall(dispatchReplyFromConfig, 0);
      const body = String(firstCall?.ctx?.Body ?? "");
      expect(body).toContain("[persona] Specific incident persona.");
      expect(body).not.toContain("[persona] Broad stream persona.");

      monitor.stop();
      await (monitor as { done: Promise<void> }).done;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

});
