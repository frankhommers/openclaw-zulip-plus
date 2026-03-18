import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi, describe, expect, it } from "vitest";
import {
  evaluateAllowedBotChain,
  isBotAlreadyHandled,
  resolveBotSenderClassification,
} from "./monitor.js";
import {
  isZulipMessageProcessed,
  loadZulipProcessedMessageState,
  markZulipMessageProcessed,
  writeZulipProcessedMessageState,
} from "./processed-message-state.js";

const BOT_USER_ID = 42;
const SUCCESS_EMOJI = "check";
const FAILURE_EMOJI = "warning";

function makeMessage(
  id: number,
  overrides?: {
    reactions?: Array<{ emoji_name: string; user_id: number }>;
    sender_id?: number;
  },
) {
  return {
    id,
    type: "stream" as const,
    sender_id: overrides?.sender_id ?? 99,
    reactions: overrides?.reactions,
  };
}

function makeParams(overrides?: {
  message?: ReturnType<typeof makeMessage>;
  stream?: string;
  topic?: string;
  fetchMessage?: ReturnType<typeof vi.fn>;
  fetchNewestInTopic?: ReturnType<typeof vi.fn>;
  log?: ReturnType<typeof vi.fn>;
}) {
  return {
    message: overrides?.message ?? makeMessage(1000),
    botUserId: BOT_USER_ID,
    successEmoji: SUCCESS_EMOJI,
    failureEmoji: FAILURE_EMOJI,
    stream: overrides?.stream ?? "general",
    topic: overrides?.topic ?? "test topic",
    fetchMessage: overrides?.fetchMessage ?? vi.fn().mockResolvedValue(undefined),
    fetchNewestInTopic: overrides?.fetchNewestInTopic ?? vi.fn().mockResolvedValue(undefined),
    log: overrides?.log ?? vi.fn(),
  };
}

describe("isBotAlreadyHandled", () => {
  describe("reaction check", () => {
    it("returns handled when message has bot success reaction inline", async () => {
      const msg = makeMessage(100, {
        reactions: [{ emoji_name: SUCCESS_EMOJI, user_id: BOT_USER_ID }],
      });
      const fetchMessage = vi.fn();

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchMessage }),
      );

      expect(result).toEqual({ handled: true, reason: "bot-completion-reaction", completion: "success" });
      // Should NOT call fetchMessage since reactions were inline
      expect(fetchMessage).not.toHaveBeenCalled();
    });

    it("returns handled when message has bot failure reaction inline", async () => {
      const msg = makeMessage(100, {
        reactions: [{ emoji_name: FAILURE_EMOJI, user_id: BOT_USER_ID }],
      });

      const result = await isBotAlreadyHandled(makeParams({ message: msg }));

      expect(result).toEqual({ handled: true, reason: "bot-completion-reaction", completion: "failure" });
    });

    it("ignores reactions from other users", async () => {
      const msg = makeMessage(100, {
        reactions: [{ emoji_name: SUCCESS_EMOJI, user_id: 999 }],
      });
      const fetchNewestInTopic = vi.fn().mockResolvedValue({ sender_id: 999, id: 200 });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
    });

    it("ignores non-completion reactions from bot", async () => {
      const msg = makeMessage(100, {
        reactions: [{ emoji_name: "eyes", user_id: BOT_USER_ID }],
      });
      const fetchNewestInTopic = vi.fn().mockResolvedValue({ sender_id: 999, id: 200 });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
    });

    it("fetches message reactions when not inline (real-time event)", async () => {
      const msg = makeMessage(100); // no reactions field
      const fetchMessage = vi.fn().mockResolvedValue({
        reactions: [{ emoji_name: SUCCESS_EMOJI, user_id: BOT_USER_ID }],
      });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchMessage }),
      );

      expect(fetchMessage).toHaveBeenCalledWith(100);
      expect(result).toEqual({ handled: true, reason: "bot-completion-reaction", completion: "success" });
    });

    it("proceeds to last-sender check when fetched message has no bot reaction", async () => {
      const msg = makeMessage(100);
      const fetchMessage = vi.fn().mockResolvedValue({
        reactions: [{ emoji_name: "thumbs_up", user_id: 999 }],
      });
      const fetchNewestInTopic = vi.fn().mockResolvedValue({ sender_id: 999, id: 200 });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchMessage, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
      expect(fetchNewestInTopic).toHaveBeenCalledWith("general", "test topic");
    });

    it("gracefully handles fetchMessage failure", async () => {
      const msg = makeMessage(100);
      const fetchMessage = vi.fn().mockRejectedValue(new Error("network error"));
      const fetchNewestInTopic = vi.fn().mockResolvedValue({ sender_id: 999, id: 200 });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchMessage, fetchNewestInTopic }),
      );

      // Should not crash, should proceed to check 2 then return not handled
      expect(result).toEqual({ handled: false });
    });
  });

  describe("last-sender check", () => {
    it("returns handled when bot was last sender in topic", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn().mockResolvedValue({
        sender_id: BOT_USER_ID,
        id: 200,
      });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: true, reason: "bot-was-last-sender" });
      expect(fetchNewestInTopic).toHaveBeenCalledWith("general", "test topic");
    });

    it("returns not handled when human was last sender", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn().mockResolvedValue({
        sender_id: 999,
        id: 200,
      });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
    });

    it("returns not handled when fetchNewestInTopic returns undefined", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn().mockResolvedValue(undefined);

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
    });

    it("gracefully handles fetchNewestInTopic failure", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn().mockRejectedValue(new Error("timeout"));

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
    });

    it("skips last-sender check when stream is empty", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn();

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, stream: "", fetchNewestInTopic }),
      );

      expect(fetchNewestInTopic).not.toHaveBeenCalled();
      expect(result).toEqual({ handled: false });
    });

    it("skips last-sender check when topic is empty", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn();

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, topic: "", fetchNewestInTopic }),
      );

      expect(fetchNewestInTopic).not.toHaveBeenCalled();
      expect(result).toEqual({ handled: false });
    });
  });

  describe("check priority", () => {
    it("reaction check takes precedence over last-sender check", async () => {
      // Message has bot success reaction AND bot was last sender
      const msg = makeMessage(100, {
        reactions: [{ emoji_name: SUCCESS_EMOJI, user_id: BOT_USER_ID }],
      });
      const fetchNewestInTopic = vi.fn().mockResolvedValue({
        sender_id: BOT_USER_ID,
        id: 200,
      });

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic }),
      );

      // Should return reaction reason (check 1), not last-sender (check 2)
      expect(result).toEqual({ handled: true, reason: "bot-completion-reaction", completion: "success" });
      // Should NOT even call fetchNewestInTopic since check 1 was conclusive
      expect(fetchNewestInTopic).not.toHaveBeenCalled();
    });
  });

  describe("logging", () => {
    it("logs when skipping due to reaction", async () => {
      const msg = makeMessage(100, {
        reactions: [{ emoji_name: SUCCESS_EMOJI, user_id: BOT_USER_ID }],
      });
      const log = vi.fn();

      await isBotAlreadyHandled(makeParams({ message: msg, log }));

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("skipping message 100"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("completion reaction"),
      );
    });

    it("logs when skipping due to last sender", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn().mockResolvedValue({
        sender_id: BOT_USER_ID,
        id: 200,
      });
      const log = vi.fn();

      await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic, log }),
      );

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("skipping message 100"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("last sender"),
      );
    });

    it("does not log when message is not handled", async () => {
      const msg = makeMessage(100);
      const fetchNewestInTopic = vi.fn().mockResolvedValue({ sender_id: 999, id: 200 });
      const log = vi.fn();

      await isBotAlreadyHandled(
        makeParams({ message: msg, fetchNewestInTopic, log }),
      );

      expect(log).not.toHaveBeenCalled();
    });
  });

  describe("both checks fail gracefully", () => {
    it("returns not handled when both API calls fail", async () => {
      const msg = makeMessage(100);
      const fetchMessage = vi.fn().mockRejectedValue(new Error("fail 1"));
      const fetchNewestInTopic = vi.fn().mockRejectedValue(new Error("fail 2"));

      const result = await isBotAlreadyHandled(
        makeParams({ message: msg, fetchMessage, fetchNewestInTopic }),
      );

      expect(result).toEqual({ handled: false });
    });
  });
});

describe("processed message watermark state", () => {
  it("persists processed stream watermarks to disk", async () => {
    const stateFilePath = path.join(
      os.tmpdir(),
      `zulip-processed-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );

    try {
      const state = await loadZulipProcessedMessageState({ stateFilePath });
      expect(
        isZulipMessageProcessed({
          state,
          stream: "marcel",
          messageId: 100,
        }),
      ).toBe(false);

      expect(
        markZulipMessageProcessed({
          state,
          stream: "marcel",
          messageId: 100,
        }),
      ).toBe(true);
      await writeZulipProcessedMessageState({ state, stateFilePath });

      const reloaded = await loadZulipProcessedMessageState({ stateFilePath });
      expect(
        isZulipMessageProcessed({
          state: reloaded,
          stream: "marcel",
          messageId: 100,
        }),
      ).toBe(true);
      expect(
        isZulipMessageProcessed({
          state: reloaded,
          stream: "marcel",
          messageId: 101,
        }),
      ).toBe(false);
    } finally {
      await fs.rm(stateFilePath, { force: true });
    }
  });

  it("does not treat missing earlier messages as processed when later ones completed first", async () => {
    const state = await loadZulipProcessedMessageState();

    expect(
      markZulipMessageProcessed({
        state,
        stream: "marcel",
        messageId: 101,
      }),
    ).toBe(true);

    expect(
      isZulipMessageProcessed({
        state,
        stream: "marcel",
        messageId: 100,
      }),
    ).toBe(false);
    expect(
      isZulipMessageProcessed({
        state,
        stream: "marcel",
        messageId: 101,
      }),
    ).toBe(true);

    expect(
      markZulipMessageProcessed({
        state,
        stream: "marcel",
        messageId: 100,
      }),
    ).toBe(true);

    expect(
      isZulipMessageProcessed({
        state,
        stream: "marcel",
        messageId: 100,
      }),
    ).toBe(true);
    expect(
      isZulipMessageProcessed({
        state,
        stream: "marcel",
        messageId: 101,
      }),
    ).toBe(true);
  });
});

describe("resolveBotSenderClassification", () => {
  it("classifies self messages as self", () => {
    const result = resolveBotSenderClassification({
      message: makeMessage(10, { sender_id: 42 }),
      botUserId: 42,
      allowBotIds: new Set([77]),
    });

    expect(result).toBe("self");
  });

  it("classifies allowlisted bot IDs as allowed-bot", () => {
    const result = resolveBotSenderClassification({
      message: makeMessage(10, { sender_id: 77 }),
      botUserId: 42,
      allowBotIds: new Set([77]),
    });

    expect(result).toBe("allowed-bot");
  });

  it("classifies non-allowlisted bot senders as other-bot", () => {
    const result = resolveBotSenderClassification({
      message: {
        ...makeMessage(10, { sender_id: 88 }),
        sender_email: "helper-bot@example.com",
      },
      botUserId: 42,
      allowBotIds: new Set([77]),
    });

    expect(result).toBe("other-bot");
  });

  it("classifies regular human senders as human", () => {
    const result = resolveBotSenderClassification({
      message: {
        ...makeMessage(10, { sender_id: 91 }),
        sender_email: "human@example.com",
        sender_full_name: "Human User",
      },
      botUserId: 42,
      allowBotIds: new Set([77]),
    });

    expect(result).toBe("human");
  });
});

describe("evaluateAllowedBotChain", () => {
  it("increments depth for allowlisted bots within cooldown", () => {
    const chainStateByThread = new Map<string, { depth: number; lastMessageAtMs: number; startedAtMs: number }>();

    const first = evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 1_000,
      maxChainLength: 3,
      cooldownMs: 60_000,
    });
    const second = evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 2_000,
      maxChainLength: 3,
      cooldownMs: 60_000,
    });

    expect(first).toMatchObject({ allow: true, depth: 1 });
    expect(second).toMatchObject({ allow: true, depth: 2 });
  });

  it("blocks loops once max chain length is exceeded", () => {
    const chainStateByThread = new Map<string, { depth: number; lastMessageAtMs: number; startedAtMs: number }>();

    evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 1_000,
      maxChainLength: 2,
      cooldownMs: 60_000,
    });
    evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 2_000,
      maxChainLength: 2,
      cooldownMs: 60_000,
    });
    const third = evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 3_000,
      maxChainLength: 2,
      cooldownMs: 60_000,
    });

    expect(third).toMatchObject({ allow: false, reason: "max-chain-length", depth: 3 });
  });

  it("resets chain depth after cooldown elapses", () => {
    const chainStateByThread = new Map<string, { depth: number; lastMessageAtMs: number; startedAtMs: number }>();

    evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 1_000,
      maxChainLength: 2,
      cooldownMs: 5_000,
    });
    evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 2_000,
      maxChainLength: 2,
      cooldownMs: 5_000,
    });

    const afterCooldown = evaluateAllowedBotChain({
      chainStateByThread,
      threadKey: "stream:ops#alerts",
      nowMs: 20_000,
      maxChainLength: 2,
      cooldownMs: 5_000,
    });

    expect(afterCooldown).toMatchObject({ allow: true, depth: 1 });
  });
});
