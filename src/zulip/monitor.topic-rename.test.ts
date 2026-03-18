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
  writeZulipProcessedMessageState: vi.fn(),
  isZulipMessageProcessed: vi.fn(),
  markZulipMessageProcessed: vi.fn(),
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
  writeZulipProcessedMessageState: mocks.writeZulipProcessedMessageState,
  isZulipMessageProcessed: mocks.isZulipMessageProcessed,
  markZulipMessageProcessed: mocks.markZulipMessageProcessed,
}));

import { monitorZulipProvider } from "./monitor.js";

type ZulipEventMessage = {
  id: number;
  type: "stream";
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  stream_id?: number;
  subject?: string;
  content?: string;
  timestamp?: number;
};

type ZulipQueueEvent = {
  id: number;
  type?: string;
  message?: ZulipEventMessage;
  stream_id?: number;
  orig_stream_id?: number;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  subscriptions?: Array<{ stream_id?: number; name?: string }>;
};

type ContextPayload = {
  SessionKey?: string;
  To?: string;
  MessageSid?: string;
};

function waitForCondition(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("condition timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function getDispatchContexts(dispatchReplyFromConfig: ReturnType<typeof vi.fn>): ContextPayload[] {
  const calls = dispatchReplyFromConfig.mock.calls as Array<[unknown]>;
  return calls.map((call) => (call[0] as { ctx: ContextPayload }).ctx);
}

function createHarness(events: ZulipQueueEvent[]) {
  const dispatchReplyFromConfig = vi.fn(async () => undefined);
  const registerForms: Array<Record<string, unknown>> = [];

  const runtime = {
    logging: {
      getChildLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      })),
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
          dispatcher: {
            sendToolResult: vi.fn(() => true),
            sendBlockReply: vi.fn(() => true),
            sendFinalReply: vi.fn(() => true),
            waitForIdle: vi.fn(async () => undefined),
            getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
            markComplete: vi.fn(),
          },
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

  mocks.resolveZulipAccount.mockReturnValue({
    accountId: "default",
    enabled: true,
    baseUrl: "https://zulip.example.com",
    email: "bot@zulip.example.com",
    apiKey: "api-key",
    streams: ["marcel", "ops"],
    defaultTopic: "general",
    alwaysReply: true,
    requireMention: false,
    allowBotIds: [],
    botLoopPrevention: {
      maxChainLength: 3,
      cooldownMs: 30_000,
    },
    textChunkLimit: 10_000,
    workingMessages: {
      enabled: false,
    },
    processingSpinner: {
      enabled: false,
      emoji: [],
      intervalMs: 10_000,
    },
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
    },
    config: {},
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
  mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 99 });

  mocks.loadZulipInFlightCheckpoints.mockResolvedValue([]);
  mocks.writeZulipInFlightCheckpoint.mockResolvedValue(undefined);
  mocks.clearZulipInFlightCheckpoint.mockResolvedValue(undefined);
  mocks.isZulipCheckpointStale.mockReturnValue(false);
  mocks.prepareZulipCheckpointForRecovery.mockImplementation(
    ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
  );
  mocks.markZulipCheckpointFailure.mockImplementation(
    ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
  );
  mocks.buildZulipCheckpointId.mockImplementation(
    ({ accountId, messageId }: { accountId: string; messageId: number }) =>
      `${accountId}:${messageId}`,
  );
  mocks.loadZulipProcessedMessageState.mockResolvedValue({ version: 1, watermarks: {} });
  mocks.writeZulipProcessedMessageState.mockResolvedValue(undefined);
  mocks.isZulipMessageProcessed.mockReturnValue(false);
  mocks.markZulipMessageProcessed.mockReturnValue(true);

  let pollCount = 0;
  mocks.zulipRequest.mockImplementation(
    async ({
      path,
      method,
      form,
      abortSignal,
    }: {
      path: string;
      method?: string;
      form?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }) => {
      if (path === "/api/v1/users/me") {
        return { result: "success", user_id: 9 };
      }
      if (path === "/api/v1/users/me/subscriptions") {
        return {
          result: "success",
          subscriptions: [
            { stream_id: 42, name: "marcel" },
            { stream_id: 43, name: "ops" },
          ],
        };
      }
      if (path === "/api/v1/register") {
        registerForms.push(form ?? {});
        return { result: "success", queue_id: "queue-1", last_event_id: 100 };
      }
      if (path === "/api/v1/events" && method === "DELETE") {
        return { result: "success" };
      }
      if (path === "/api/v1/events") {
        pollCount += 1;
        if (pollCount === 1) {
          return { result: "success", events };
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
      return { result: "success" };
    },
  );

  return { dispatchReplyFromConfig, registerForms };
}

function makeMessage(
  messageId: number,
  topic: string,
  stream = "marcel",
  streamId = 42,
): ZulipEventMessage {
  return {
    id: messageId,
    type: "stream",
    sender_id: 55,
    sender_full_name: "Tester",
    display_recipient: stream,
    stream_id: streamId,
    subject: topic,
    content: "hello",
    timestamp: Math.floor(Date.now() / 1000),
  };
}

describe("monitorZulipProvider topic rename session continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to update_message events and creates rename aliases", async () => {
    const { dispatchReplyFromConfig, registerForms } = createHarness([
      {
        id: 101,
        type: "update_message",
        orig_subject: "alpha",
        subject: "beta",
      },
      {
        id: 102,
        message: makeMessage(9001, "beta"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const registerForm = registerForms[0];
    const eventTypes = JSON.parse(String(registerForm?.event_types ?? "[]")) as string[];
    expect(eventTypes).toContain("update_message");

    const [ctx] = getDispatchContexts(dispatchReplyFromConfig);
    expect(ctx.SessionKey).toBe("session-key:topic:marcel:alpha");
    expect(ctx.To).toBe("stream:marcel#beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("keeps the same session key for messages after a topic rename", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        message: makeMessage(9011, "alpha"),
      },
      {
        id: 102,
        type: "update_message",
        orig_subject: "alpha",
        subject: "beta",
      },
      {
        id: 103,
        message: makeMessage(9012, "beta"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = getDispatchContexts(dispatchReplyFromConfig);
    const first = contexts.find((ctx) => ctx.MessageSid === "9011");
    const second = contexts.find((ctx) => ctx.MessageSid === "9012");

    expect(first?.SessionKey).toBe("session-key:topic:marcel:alpha");
    expect(second?.SessionKey).toBe("session-key:topic:marcel:alpha");
    expect(second?.To).toBe("stream:marcel#beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("resolves chained topic renames to the original canonical session key", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        type: "update_message",
        orig_topic: "alpha",
        topic: "beta",
      },
      {
        id: 102,
        type: "update_message",
        orig_subject: "beta",
        subject: "gamma",
      },
      {
        id: 103,
        message: makeMessage(9003, "gamma"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const [ctx] = getDispatchContexts(dispatchReplyFromConfig);
    expect(ctx.SessionKey).toBe("session-key:topic:marcel:alpha");
    expect(ctx.To).toBe("stream:marcel#gamma");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("ignores non-rename update_message events", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        type: "update_message",
        subject: "beta",
      },
      {
        id: 102,
        type: "update_message",
        orig_subject: "beta",
        subject: "beta",
      },
      {
        id: 103,
        message: makeMessage(9004, "beta"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const [ctx] = getDispatchContexts(dispatchReplyFromConfig);
    expect(ctx.SessionKey).toBe("session-key:topic:marcel:beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("keeps session continuity when a topic moves across streams", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        message: makeMessage(9101, "alpha", "marcel", 42),
      },
      {
        id: 102,
        type: "update_message",
        orig_stream_id: 42,
        stream_id: 43,
        orig_topic: "alpha",
        topic: "beta",
      },
      {
        id: 103,
        message: makeMessage(9102, "beta", "ops", 43),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = getDispatchContexts(dispatchReplyFromConfig);
    const first = contexts.find((ctx) => ctx.MessageSid === "9101");
    const second = contexts.find((ctx) => ctx.MessageSid === "9102");

    expect(first?.SessionKey).toBe("session-key:topic:marcel:alpha");
    expect(second?.SessionKey).toBe("session-key:topic:marcel:alpha");
    expect(second?.To).toBe("stream:ops#beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });
});
