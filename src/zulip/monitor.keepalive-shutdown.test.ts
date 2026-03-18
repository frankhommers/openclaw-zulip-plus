import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKeepaliveMessageContent,
  createMainMessageRelayHooks,
  createBestEffortShutdownNoticeSender,
  startPeriodicKeepalive,
} from "./monitor.js";
import {
  clearMainMessageRunRelay,
  lookupMainMessageRunRelay,
  updateMainMessageRunRelay,
} from "../agents/subagent-relay.js";

describe("monitor keepalive + shutdown helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearMainMessageRunRelay({
      provider: "zulip",
      accountId: "acct-1",
      messageId: "101",
    });
  });

  it("sends periodic keepalives after the initial delay", async () => {
    vi.useFakeTimers();

    const sendPing = vi.fn().mockResolvedValue(undefined);
    const stop = startPeriodicKeepalive({
      sendPing,
      initialDelayMs: 25_000,
      repeatIntervalMs: 60_000,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(sendPing).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendPing).toHaveBeenCalledTimes(1);
    expect(sendPing).toHaveBeenNthCalledWith(1, 25_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendPing).toHaveBeenCalledTimes(2);
    expect(sendPing).toHaveBeenNthCalledWith(2, 85_000);

    stop();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(sendPing).toHaveBeenCalledTimes(2);
  });

  it("builds concise keepalive copy with elapsed time", () => {
    expect(buildKeepaliveMessageContent(29_000, new Date("2026-03-03T14:23:10").getTime())).toBe(
      "🔧 Still working... (29s elapsed, last activity 14:23:10)",
    );
    expect(buildKeepaliveMessageContent(120_000, new Date("2026-03-03T08:00:00").getTime())).toBe(
      "🔧 Still working... (2m elapsed, last activity 08:00:00)",
    );
  });

  it("formats last activity in provided timezone", () => {
    const ts = Date.UTC(2026, 2, 3, 7, 39, 58);
    expect(buildKeepaliveMessageContent(25_000, ts, "UTC")).toBe(
      "🔧 Still working... (25s elapsed, last activity 07:39:58)",
    );
  });

  it("sends shutdown notice once and swallows errors", async () => {
    const sendNotice = vi.fn().mockRejectedValue(new Error("boom"));
    const log = vi.fn();

    const sendShutdownNoticeOnce = createBestEffortShutdownNoticeSender({ sendNotice, log });

    expect(() => {
      sendShutdownNoticeOnce();
      sendShutdownNoticeOnce();
    }).not.toThrow();

    await Promise.resolve();

    expect(sendNotice).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("shutdown notice failed"));
  });

  it("registers and updates relay state for the main message run", () => {
    const relay = createMainMessageRelayHooks({
      provider: "zulip",
      accountId: "acct-1",
      messageId: "101",
      now: () => 10,
    });

    expect(
      lookupMainMessageRunRelay({
        provider: "zulip",
        accountId: "acct-1",
        messageId: "101",
      }),
    ).toMatchObject({
      runId: "zulip:acct-1:101",
      status: "dispatching",
      updatedAtMs: 10,
    });

    relay.onModelSelected({ model: "gpt-5" });
    relay.markStatus("retrying");

    expect(
      lookupMainMessageRunRelay({
        provider: "zulip",
        accountId: "acct-1",
        messageId: "101",
      }),
    ).toMatchObject({
      runId: "zulip:acct-1:101",
      model: "gpt-5",
      status: "retrying",
    });

    relay.clear();
    expect(
      lookupMainMessageRunRelay({
        provider: "zulip",
        accountId: "acct-1",
        messageId: "101",
      }),
    ).toBeUndefined();
  });

  it("ignores relay updates after cleanup", () => {
    const relay = createMainMessageRelayHooks({
      provider: "zulip",
      accountId: "acct-1",
      messageId: "101",
    });
    relay.clear();

    expect(() => {
      relay.markStatus("completed");
      relay.onModelSelected({ model: "ignored" });
      updateMainMessageRunRelay("zulip:acct-1:101", { status: "completed" });
    }).not.toThrow();

    expect(
      lookupMainMessageRunRelay({
        provider: "zulip",
        accountId: "acct-1",
        messageId: "101",
      }),
    ).toBeUndefined();
  });
});
