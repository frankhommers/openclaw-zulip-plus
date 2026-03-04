import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessingSpinner } from "./monitor.js";

const AUTH = {
  baseUrl: "https://chat.example.com",
  email: "bot@example.com",
  apiKey: "test-key",
};
const EMOJI = ["new_moon", "full_moon", "waning_crescent_moon"];

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("startProcessingSpinner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds first emoji immediately and cycles on interval", async () => {
    vi.useFakeTimers();

    const addReaction = vi.fn().mockResolvedValue({ result: "success" });
    const removeReaction = vi.fn().mockResolvedValue({ result: "success" });

    const stop = startProcessingSpinner({
      auth: AUTH,
      messageId: 100,
      emoji: EMOJI,
      intervalMs: 2000,
      addReaction,
      removeReaction,
    });

    // First emoji added immediately
    vi.advanceTimersByTime(0);
    await flushMicrotasks();
    expect(addReaction).toHaveBeenCalledTimes(1);
    expect(addReaction).toHaveBeenCalledWith(expect.objectContaining({ emojiName: "new_moon" }));

    // After 2s, should remove old and add new
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(removeReaction).toHaveBeenCalledWith(expect.objectContaining({ emojiName: "new_moon" }));
    expect(addReaction).toHaveBeenCalledWith(expect.objectContaining({ emojiName: "full_moon" }));

    // After another 2s, next in cycle
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(addReaction).toHaveBeenCalledWith(
      expect.objectContaining({ emojiName: "waning_crescent_moon" }),
    );

    await stop();
  });

  it("removes current emoji when stopped", async () => {
    const addReaction = vi.fn().mockResolvedValue({ result: "success" });
    const removeReaction = vi.fn().mockResolvedValue({ result: "success" });

    const stop = startProcessingSpinner({
      auth: AUTH,
      messageId: 200,
      emoji: EMOJI,
      intervalMs: 2000,
      addReaction,
      removeReaction,
    });

    // Wait for first emoji to be added
    await new Promise((r) => setTimeout(r, 50));

    await stop();

    // Should remove the current emoji on stop
    expect(removeReaction).toHaveBeenCalledWith(expect.objectContaining({ emojiName: "new_moon" }));
  });

  it("skips failed emoji and continues to next", async () => {
    vi.useFakeTimers();

    const addReaction = vi
      .fn()
      .mockResolvedValueOnce({ result: "success" })
      .mockRejectedValueOnce(new Error("unknown emoji"))
      .mockResolvedValue({ result: "success" });
    const removeReaction = vi.fn().mockResolvedValue({ result: "success" });
    const log = vi.fn();

    const stop = startProcessingSpinner({
      auth: AUTH,
      messageId: 300,
      emoji: EMOJI,
      intervalMs: 2000,
      addReaction,
      removeReaction,
      log,
    });

    vi.advanceTimersByTime(0);
    await flushMicrotasks();
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();

    // full_moon failed, but should have logged
    expect(log).toHaveBeenCalledWith(expect.stringContaining("full_moon"));

    await stop();
  });

  it("returns noop for empty emoji array", async () => {
    const addReaction = vi.fn();
    const removeReaction = vi.fn();

    const stop = startProcessingSpinner({
      auth: AUTH,
      messageId: 400,
      emoji: [],
      intervalMs: 2000,
      addReaction,
      removeReaction,
    });

    await stop();
    expect(addReaction).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });
});
