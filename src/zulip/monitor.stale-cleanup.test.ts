import { describe, expect, it, vi } from "vitest";
import {
  cleanupStaleStatusMessages,
  ZULIP_KEEPALIVE_PREFIX,
  ZULIP_SHUTDOWN_NOTICE_PREFIX,
  ZULIP_RECOVERY_PREFIX,
} from "./monitor.js";

// Minimal ZulipAuth shape
const AUTH = { baseUrl: "https://chat.example.com", email: "bot@example.com", apiKey: "test-key" };

function makeMessage(id: number, content: string, senderEmail = AUTH.email) {
  return { id, content, sender_email: senderEmail };
}

describe("cleanupStaleStatusMessages", () => {
  it("deletes messages matching all three status prefixes", async () => {
    const messages = [
      makeMessage(1, `${ZULIP_KEEPALIVE_PREFIX} (42s elapsed, last activity 14:23:10)`),
      makeMessage(2, `${ZULIP_SHUTDOWN_NOTICE_PREFIX} - reconnecting now.`),
      makeMessage(3, `${ZULIP_RECOVERY_PREFIX} - resuming the previous task now...`),
      makeMessage(4, "Hello, this is a normal user message"),
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);

    await cleanupStaleStatusMessages({
      auth: AUTH,
      streams: ["general", "engineering"],
      fetchMessages,
      deleteMessage,
      maxPerStream: 500,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    // Should fetch for both streams
    expect(fetchMessages).toHaveBeenCalledTimes(2);
    expect(fetchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ stream: "general", senderEmail: AUTH.email, limit: 500 }),
    );
    expect(fetchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ stream: "engineering", senderEmail: AUTH.email, limit: 500 }),
    );

    // Should delete 3 matching messages × 2 streams = 6
    expect(deleteMessage).toHaveBeenCalledTimes(6);
  });

  it("skips messages that do not match any status prefix", async () => {
    const messages = [
      makeMessage(10, "Regular bot response with some content"),
      makeMessage(11, "🔧 Configured the settings"),
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const deleteMessage = vi.fn();

    await cleanupStaleStatusMessages({
      auth: AUTH,
      streams: ["general"],
      fetchMessages,
      deleteMessage,
      maxPerStream: 500,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("swallows fetch errors and continues with remaining streams", async () => {
    const fetchMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce([
        makeMessage(20, `${ZULIP_KEEPALIVE_PREFIX} (10s elapsed, last activity 12:00:00)`),
      ]);

    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await cleanupStaleStatusMessages({
      auth: AUTH,
      streams: ["broken-stream", "good-stream"],
      fetchMessages,
      deleteMessage,
      maxPerStream: 500,
      logger: { info: vi.fn(), warn, debug: vi.fn() },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken-stream"));
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("swallows individual delete errors without aborting other deletes", async () => {
    const messages = [
      makeMessage(30, `${ZULIP_KEEPALIVE_PREFIX} (5s elapsed, last activity 09:00:00)`),
      makeMessage(31, `${ZULIP_RECOVERY_PREFIX} - resuming the previous task now...`),
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const deleteMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();

    await cleanupStaleStatusMessages({
      auth: AUTH,
      streams: ["general"],
      fetchMessages,
      deleteMessage,
      maxPerStream: 500,
      logger: { info: vi.fn(), warn, debug: vi.fn() },
    });

    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("30"));
  });

  it("does nothing for an empty stream list", async () => {
    const fetchMessages = vi.fn();
    const deleteMessage = vi.fn();

    await cleanupStaleStatusMessages({
      auth: AUTH,
      streams: [],
      fetchMessages,
      deleteMessage,
      maxPerStream: 500,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    expect(fetchMessages).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("logs summary with delete count", async () => {
    const messages = [
      makeMessage(40, `${ZULIP_KEEPALIVE_PREFIX} (99s elapsed, last activity 08:00:00)`),
    ];

    const fetchMessages = vi.fn().mockResolvedValue(messages);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const info = vi.fn();

    await cleanupStaleStatusMessages({
      auth: AUTH,
      streams: ["general"],
      fetchMessages,
      deleteMessage,
      maxPerStream: 500,
      logger: { info, warn: vi.fn(), debug: vi.fn() },
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("1"));
  });
});
