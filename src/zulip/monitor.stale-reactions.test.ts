import { describe, expect, it, vi } from "vitest";
import { cleanupStaleReactions } from "./monitor.js";

const AUTH = { baseUrl: "https://chat.example.com", email: "bot@example.com", apiKey: "test-key" };
const BOT_USER_ID = 42;

function makeMessage(
  id: number,
  reactions: Array<{ emoji_name: string; user_id: number }> = [],
) {
  return { id, reactions };
}

describe("cleanupStaleReactions", () => {
  it("removes bot reactions that match stale emoji names", async () => {
    const messages = [
      makeMessage(1, [
        { emoji_name: "eyes", user_id: BOT_USER_ID },
        { emoji_name: "thumbs_up", user_id: 99 }, // other user, ignore
      ]),
      makeMessage(2, [
        { emoji_name: "new_moon", user_id: BOT_USER_ID },
      ]),
      makeMessage(3, []), // no reactions
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    await cleanupStaleReactions({
      auth: AUTH,
      streams: ["general"],
      botUserId: BOT_USER_ID,
      staleEmojiNames: ["eyes", "new_moon", "full_moon"],
      fetchMessages,
      removeReaction,
      maxPerStream: 100,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    expect(removeReaction).toHaveBeenCalledTimes(2);
    expect(removeReaction).toHaveBeenCalledWith(1, "eyes");
    expect(removeReaction).toHaveBeenCalledWith(2, "new_moon");
  });

  it("ignores reactions from other users", async () => {
    const messages = [
      makeMessage(10, [
        { emoji_name: "eyes", user_id: 99 },
        { emoji_name: "new_moon", user_id: 123 },
      ]),
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const removeReaction = vi.fn();

    await cleanupStaleReactions({
      auth: AUTH,
      streams: ["general"],
      botUserId: BOT_USER_ID,
      staleEmojiNames: ["eyes", "new_moon"],
      fetchMessages,
      removeReaction,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    expect(removeReaction).not.toHaveBeenCalled();
  });

  it("swallows remove errors and continues", async () => {
    const messages = [
      makeMessage(20, [
        { emoji_name: "eyes", user_id: BOT_USER_ID },
        { emoji_name: "new_moon", user_id: BOT_USER_ID },
      ]),
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const removeReaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("already removed"))
      .mockResolvedValueOnce(undefined);

    await cleanupStaleReactions({
      auth: AUTH,
      streams: ["general"],
      botUserId: BOT_USER_ID,
      staleEmojiNames: ["eyes", "new_moon"],
      fetchMessages,
      removeReaction,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    // Both attempted, first failed but second still ran
    expect(removeReaction).toHaveBeenCalledTimes(2);
  });

  it("does nothing when staleEmojiNames is empty", async () => {
    const fetchMessages = vi.fn();
    const removeReaction = vi.fn();

    await cleanupStaleReactions({
      auth: AUTH,
      streams: ["general"],
      botUserId: BOT_USER_ID,
      staleEmojiNames: [],
      fetchMessages,
      removeReaction,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    expect(fetchMessages).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it("scans multiple streams", async () => {
    const messagesA = [makeMessage(30, [{ emoji_name: "eyes", user_id: BOT_USER_ID }])];
    const messagesB = [makeMessage(31, [{ emoji_name: "full_moon", user_id: BOT_USER_ID }])];

    const fetchMessages = vi
      .fn()
      .mockResolvedValueOnce(messagesA)
      .mockResolvedValueOnce(messagesB);
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    await cleanupStaleReactions({
      auth: AUTH,
      streams: ["stream-a", "stream-b"],
      botUserId: BOT_USER_ID,
      staleEmojiNames: ["eyes", "full_moon"],
      fetchMessages,
      removeReaction,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    expect(fetchMessages).toHaveBeenCalledTimes(2);
    expect(removeReaction).toHaveBeenCalledTimes(2);
    expect(removeReaction).toHaveBeenCalledWith(30, "eyes");
    expect(removeReaction).toHaveBeenCalledWith(31, "full_moon");
  });
});
