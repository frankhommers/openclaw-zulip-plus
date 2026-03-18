import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: vi.fn(() => ({
    accountId: "default",
    apiKey: "key",
    email: "bot@example.com",
    baseUrl: "https://zulip.example.com",
    defaultTopic: "general chat",
    enableAdminActions: false,
  })),
}));

vi.mock("./client.js", () => ({
  normalizeZulipBaseUrl: vi.fn((url: string | undefined) => url ?? ""),
  createZulipClient: vi.fn(() => ({ baseUrl: "https://zulip.example.com" })),
  addZulipReactionViaClient: vi.fn(async () => ({ result: "success" })),
  removeZulipReactionViaClient: vi.fn(async () => ({ result: "success" })),
  sendZulipStreamMessageViaClient: vi.fn(async () => ({ id: 1 })),
  sendZulipPrivateMessage: vi.fn(async () => ({ id: 2 })),
  createZulipStream: vi.fn(),
  deactivateZulipUser: vi.fn(),
  deleteZulipMessage: vi.fn(),
  deleteZulipStream: vi.fn(),
  editZulipMessage: vi.fn(),
  forwardZulipMessage: vi.fn(async () => ({ id: 987 })),
  fetchZulipMessageEditHistory: vi.fn(),
  fetchZulipMemberInfo: vi.fn(),
  fetchZulipMessages: vi.fn(),
  fetchZulipServerSettings: vi.fn(),
  fetchZulipStreams: vi.fn(),
  fetchZulipSubscriptions: vi.fn(),
  fetchZulipUserPresence: vi.fn(),
  inviteZulipUsersToStream: vi.fn(),
  renderZulipMarkdownPreview: vi.fn(async () => ({ rendered: "<p>Rendered</p>" })),
  reactivateZulipUser: vi.fn(),
  resolveZulipStreamId: vi.fn(),
  searchZulipMessages: vi.fn(),
  subscribeZulipStream: vi.fn(),
  updateZulipMessageFlag: vi.fn(),
  updateZulipMessageTopic: vi.fn(),
  updateZulipRealm: vi.fn(),
  updateZulipStream: vi.fn(),
  uploadZulipFileViaClient: vi.fn(),
}));

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { addZulipReactionViaClient } from "./client.js";
import { fetchZulipMessageEditHistory } from "./client.js";
import { forwardZulipMessage } from "./client.js";
import { renderZulipMarkdownPreview } from "./client.js";
import { searchZulipMessages } from "./client.js";
import { resolveZulipAccount } from "./accounts.js";
import { zulipMessageActions } from "./actions.js";

function buildConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    channels: {
      zulip: {
        apiKey: "key",
        email: "bot@example.com",
        baseUrl: "https://zulip.example.com",
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("zulipMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveZulipAccount).mockImplementation(({ accountId }) => ({
      accountId: accountId ?? "default",
      apiKey: "key",
      email: "bot@example.com",
      baseUrl: "https://zulip.example.com",
      defaultTopic: "general chat",
      enableAdminActions: false,
      config: {},
    }) as never);
  });

  it("falls back to toolContext.currentMessageId for react actions", async () => {
    await zulipMessageActions.handleAction!({
      action: "react",
      channel: "zulip",
      params: { emoji: "eyes" },
      cfg: {} as OpenClawConfig,
      accountId: "default",
      toolContext: { currentMessageId: "4321" } as never,
    });

    expect(addZulipReactionViaClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "4321",
        emojiName: "eyes",
      }),
    );
  });

  it("hides channel mutation actions by default", () => {
    const actions = zulipMessageActions.listActions!({ cfg: buildConfig() });

    expect(actions).not.toContain("channel-create");
    expect(actions).not.toContain("channel-edit");
    expect(actions).not.toContain("channel-delete");
  });

  it("shows channel mutation actions when enabled globally", () => {
    vi.mocked(resolveZulipAccount).mockImplementation(({ accountId }) => ({
      accountId: accountId ?? "default",
      apiKey: "key",
      email: "bot@example.com",
      baseUrl: "https://zulip.example.com",
      defaultTopic: "general chat",
      enableAdminActions: false,
      config: {
        actions: {
          "channel-create": true,
          "channel-edit": true,
          "channel-delete": true,
        },
      } as never,
    }) as never);

    const cfg = buildConfig({
      channels: {
        zulip: {
          apiKey: "key",
          email: "bot@example.com",
          baseUrl: "https://zulip.example.com",
          actions: {
            "channel-create": true,
            "channel-edit": true,
            "channel-delete": true,
          },
        },
      },
    });

    const actions = zulipMessageActions.listActions!({ cfg });

    expect(actions).toContain("channel-create");
    expect(actions).toContain("channel-edit");
    expect(actions).toContain("channel-delete");
  });

  it("rejects channel mutation dispatch when action is not enabled", async () => {
    await expect(
      zulipMessageActions.handleAction!({
        action: "channel-create",
        channel: "zulip",
        params: { stream: "ops" },
        cfg: buildConfig(),
        accountId: "default",
      }),
    ).rejects.toThrow('Action channel-create is not enabled for Zulip account "default".');
  });

  it("allows channel mutation dispatch when action is enabled for account", async () => {
    vi.mocked(resolveZulipAccount).mockImplementation(({ accountId }) => ({
      accountId: accountId ?? "default",
      apiKey: "key",
      email: "bot@example.com",
      baseUrl: "https://zulip.example.com",
      defaultTopic: "general chat",
      enableAdminActions: false,
      config: {
        actions: {
          "channel-create": true,
        },
      } as never,
    }) as never);

    await expect(
      zulipMessageActions.handleAction!({
        action: "channel-create",
        channel: "zulip",
        params: { stream: "ops" },
        cfg: buildConfig(),
        accountId: "default",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({ ok: true, stream: "ops" }),
      }),
    );
  });

  it("merges global and account-level action toggles", () => {
    vi.mocked(resolveZulipAccount).mockImplementation(({ accountId }) => ({
      accountId: accountId ?? "default",
      apiKey: "key",
      email: "bot@example.com",
      baseUrl: "https://zulip.example.com",
      defaultTopic: "general chat",
      enableAdminActions: false,
      config: {
        actions: {
          "channel-create": true,
          "channel-edit": false,
          "channel-delete": true,
        },
      } as never,
    }) as never);

    const actions = zulipMessageActions.listActions!({ cfg: buildConfig() });

    expect(actions).toContain("channel-create");
    expect(actions).not.toContain("channel-edit");
    expect(actions).toContain("channel-delete");
  });

  it("returns message edit history payload for history actions", async () => {
    vi.mocked(fetchZulipMessageEditHistory).mockResolvedValue([
      {
        timestamp: 1710000000,
        prev_content: "Old",
        content: "New",
      },
    ] as never);

    const result = await zulipMessageActions.handleAction!({
      action: "history" as never,
      channel: "zulip",
      params: { messageId: "123" },
      cfg: buildConfig(),
      accountId: "default",
    });

    expect(fetchZulipMessageEditHistory).toHaveBeenCalledWith(expect.anything(), "123");
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: true,
          messageId: "123",
          history: expect.arrayContaining([
            expect.objectContaining({
              timestamp: 1710000000,
              prev_content: "Old",
              content: "New",
            }),
          ]),
        }),
      }),
    );
  });

  it("forwards messages via the forward action", async () => {
    const result = await zulipMessageActions.handleAction!({
      action: "forward" as never,
      channel: "zulip",
      params: {
        messageId: "321",
        to: "stream:ops",
        topic: "incident/123",
      },
      cfg: buildConfig(),
      accountId: "default",
    });

    expect(forwardZulipMessage).toHaveBeenCalledWith(expect.anything(), {
      messageId: "321",
      to: "stream:ops",
      topic: "incident/123",
    });
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: true,
          messageId: "321",
          forwarded: 987,
        }),
      }),
    );
  });

  it("renders markdown previews via the render action", async () => {
    const result = await zulipMessageActions.handleAction!({
      action: "render" as never,
      channel: "zulip",
      params: {
        content: "**hello**",
      },
      cfg: buildConfig(),
      accountId: "default",
    });

    expect(renderZulipMarkdownPreview).toHaveBeenCalledWith(expect.anything(), {
      content: "**hello**",
    });
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: true,
          rendered: "<p>Rendered</p>",
        }),
      }),
    );
  });

  it("passes DM filters through search actions", async () => {
    vi.mocked(searchZulipMessages).mockResolvedValue([] as never);

    await zulipMessageActions.handleAction!({
      action: "search",
      channel: "zulip",
      params: {
        query: "deploy",
        dmWith: ["alice@example.com", "bob@example.com"],
      },
      cfg: buildConfig(),
      accountId: "default",
    });

    expect(searchZulipMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: "deploy",
        dmWith: ["alice@example.com", "bob@example.com"],
      }),
    );
  });
});
