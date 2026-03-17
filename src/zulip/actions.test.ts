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
  fetchZulipMemberInfo: vi.fn(),
  fetchZulipMessages: vi.fn(),
  fetchZulipServerSettings: vi.fn(),
  fetchZulipStreams: vi.fn(),
  fetchZulipSubscriptions: vi.fn(),
  fetchZulipUserPresence: vi.fn(),
  inviteZulipUsersToStream: vi.fn(),
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
import { zulipMessageActions } from "./actions.js";

describe("zulipMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
