import { afterEach, describe, expect, it, vi } from "vitest";
import { zulipRequest } from "./client.js";

describe("zulipRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a Zulip User-Agent header on API requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await zulipRequest({
      auth: {
        baseUrl: "https://zulip.example.com",
        email: "bot@example.com",
        apiKey: "secret",
      },
      method: "GET",
      path: "/api/v1/server_settings",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringMatching(/openclaw/i),
        }),
      }),
    );
  });
});
