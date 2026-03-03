import { describe, expect, it } from "vitest";
import { isSubscribedMode, SUBSCRIBED_TOKEN } from "./types.js";

describe("SUBSCRIBED_TOKEN", () => {
  it("equals {subscribed}", () => {
    expect(SUBSCRIBED_TOKEN).toBe("{subscribed}");
  });
});

describe("isSubscribedMode", () => {
  it("returns true when token is present", () => {
    expect(isSubscribedMode(["{subscribed}"])).toBe(true);
  });

  it("returns true when token is present among others", () => {
    expect(isSubscribedMode(["general", "{subscribed}", "ops"])).toBe(true);
  });

  it("returns false for a normal allowlist", () => {
    expect(isSubscribedMode(["general", "ops"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(isSubscribedMode([])).toBe(false);
  });

  it("handles whitespace around token", () => {
    expect(isSubscribedMode(["  {subscribed}  "])).toBe(true);
  });
});
