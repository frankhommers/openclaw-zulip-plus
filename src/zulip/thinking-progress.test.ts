import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: vi.fn(async () => ({ result: "success", id: 12345 })),
  editZulipStreamMessage: vi.fn(async () => ({ result: "success" })),
}));

import type { ZulipAuth } from "./client.js";
import { editZulipStreamMessage, sendZulipStreamMessage } from "./send.js";
import { ThinkingAccumulator } from "./thinking-progress.js";

const mockSend = vi.mocked(sendZulipStreamMessage);
const mockEdit = vi.mocked(editZulipStreamMessage);

function makeAuth(): ZulipAuth {
  return {
    baseUrl: "https://zulip.example",
    email: "bot@zulip.example",
    apiKey: "fake-key",
  };
}

function makeAccumulator(overrides?: { log?: (m: string) => void; debounceMs?: number }) {
  return new ThinkingAccumulator({
    auth: makeAuth(),
    stream: "test-stream",
    topic: "test-topic",
    debounceMs: overrides?.debounceMs ?? 300,
    log: overrides?.log,
  });
}

describe("ThinkingAccumulator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockClear();
    mockEdit.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not send until debounce fires", () => {
    const acc = makeAccumulator();
    acc.append("Let me think about this...");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("sends message with spoiler after debounce interval", async () => {
    mockSend.mockResolvedValueOnce({ result: "success", id: 100 });

    const acc = makeAccumulator();
    acc.append("Analyzing the problem...");

    await vi.advanceTimersByTimeAsync(400);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0]![0];
    expect(call.stream).toBe("test-stream");
    expect(call.topic).toBe("test-topic");
    const content = call.content;
    expect(content).toContain("```spoiler Thinking");
    expect(content).toContain("Analyzing the problem...");
    expect(content).toContain("Thinking...");
    expect(content).toContain("updated");
    expect(content).toMatch(/```$/);
    expect(acc.hasSentMessage).toBe(true);
  });

  it("edits existing message on subsequent flushes", async () => {
    mockSend.mockResolvedValueOnce({ result: "success", id: 200 });
    mockEdit.mockResolvedValueOnce({ result: "success" });

    const acc = makeAccumulator();
    acc.append("First thought.");
    await acc.flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(acc.hasSentMessage).toBe(true);

    acc.append(" Second thought.");
    await acc.flush();

    expect(mockEdit).toHaveBeenCalledTimes(1);
    const editCall = mockEdit.mock.calls[0]![0];
    expect(editCall.messageId).toBe(200);
    expect(editCall.content).toContain("First thought. Second thought.");
  });

  it("finalize updates header to 'Thinking complete'", async () => {
    mockSend.mockResolvedValueOnce({ result: "success", id: 300 });
    mockEdit.mockResolvedValueOnce({ result: "success" });

    const acc = makeAccumulator();
    vi.setSystemTime(new Date("2026-03-30T10:00:00"));
    acc.append("a]".repeat(200)); // 400 chars -> ~100 tokens
    await acc.flush();

    vi.setSystemTime(new Date("2026-03-30T10:00:05"));
    await acc.finalize();

    expect(mockEdit).toHaveBeenCalledTimes(1);
    const content = mockEdit.mock.calls[0]![0].content;
    expect(content).toContain("Thinking complete");
    expect(content).toContain("tokens");
    expect(content).toContain("5.0s");
    expect(content).not.toContain("Thinking...");
  });

  it("dispose cancels pending flush", async () => {
    const acc = makeAccumulator();
    acc.append("Some thought...");
    acc.dispose();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("hasContent reports correctly", () => {
    const acc = makeAccumulator();
    expect(acc.hasContent).toBe(false);
    acc.append("hello");
    expect(acc.hasContent).toBe(true);
  });

  it("sanitizes triple backticks in content", async () => {
    mockSend.mockResolvedValueOnce({ result: "success", id: 400 });

    const acc = makeAccumulator();
    acc.append("Here is code: ```python\nprint('hi')\n```");
    await acc.flush();

    const content = mockSend.mock.calls[0]![0].content;
    const spoilerMatch = content.match(/```spoiler Thinking\n([\s\S]*?)\n```$/);
    expect(spoilerMatch).not.toBeNull();
    const inner = spoilerMatch![1]!;
    // Inner content should not contain raw triple backticks
    expect(inner).not.toMatch(/`{3}/);
  });

  it("ignores append after finalization", async () => {
    mockSend.mockResolvedValueOnce({ result: "success", id: 500 });

    const acc = makeAccumulator();
    acc.append("First");
    await acc.finalize();

    const callCount = mockSend.mock.calls.length + mockEdit.mock.calls.length;
    acc.append("Should be ignored");
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockSend.mock.calls.length + mockEdit.mock.calls.length).toBe(callCount);
  });

  it("does nothing when finalized with no content", async () => {
    const acc = makeAccumulator();
    await acc.finalize();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("logs errors on flush failure", async () => {
    mockSend.mockRejectedValueOnce(new Error("network error"));
    const log = vi.fn();

    const acc = makeAccumulator({ log });
    acc.append("Some thinking...");
    await acc.flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("thinking flush failed"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network error"));
  });

  it("estimateTokens formats correctly", () => {
    expect(ThinkingAccumulator.estimateTokens("a".repeat(40))).toBe("10");
    expect(ThinkingAccumulator.estimateTokens("a".repeat(4000))).toBe("1.0k");
    expect(ThinkingAccumulator.estimateTokens("a".repeat(8000))).toBe("2.0k");
    expect(ThinkingAccumulator.estimateTokens("")).toBe("0");
  });

  it("debounces rapid appends into single send", async () => {
    mockSend.mockResolvedValueOnce({ result: "success", id: 600 });

    const acc = makeAccumulator();
    acc.append("Part 1. ");
    acc.append("Part 2. ");
    acc.append("Part 3.");

    expect(mockSend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const content = mockSend.mock.calls[0]![0].content;
    expect(content).toContain("Part 1. Part 2. Part 3.");
  });
});
