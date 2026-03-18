import { describe, expect, it } from "vitest";
import { parseZulipTarget } from "./send.js";

describe("parseZulipTarget", () => {
  it("preserves separators inside stream topics for stream: targets", () => {
    expect(parseZulipTarget("stream:ops#deploy:10/30")).toEqual({
      kind: "stream",
      stream: "ops",
      topic: "deploy:10/30",
    });
  });

  it("preserves separators inside stream topics for hash-prefixed targets", () => {
    expect(parseZulipTarget("#ops:topic/with/slash")).toEqual({
      kind: "stream",
      stream: "ops",
      topic: "topic/with/slash",
    });
  });
});
