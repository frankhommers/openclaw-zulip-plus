import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./zulip/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./zulip/send.js")>();
  return {
    ...actual,
    sendMessageZulip: vi.fn(async () => ({ messageId: "100", channelId: "ops" })),
  };
});

import { zulipPlugin } from "./channel.js";
import { SUBSCRIBED_TOKEN } from "./types.js";
import { resolveZulipAccount } from "./zulip/accounts.js";
import { normalizeEmojiName } from "./zulip/normalize.js";
import { sendMessageZulip } from "./zulip/send.js";
import { parseZulipTarget } from "./zulip/targets.js";

describe("zulipPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("messaging", () => {
    it("normalizes @username and zulip: targets", () => {
      const normalize = zulipPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("user:Alice");
      expect(normalize("zulip:USER123")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = zulipPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
      expect(normalize("zulip:BOT999")).toBe("bot999");
    });
  });

  describe("config", () => {
    it("loads env values from the first existing bootstrap env file", async () => {
      const secretsEnvPath = join(homedir(), ".openclaw", "secrets", "zulip.env");
      const fallbackEnvPath = join(homedir(), ".openclaw", "zulip.env");

      const originalApiKey = process.env.ZULIP_API_KEY;
      const originalEmail = process.env.ZULIP_EMAIL;
      const originalExisting = process.env.ZULIP_EXISTING;

      process.env.ZULIP_EXISTING = "keep-me";
      delete process.env.ZULIP_API_KEY;
      delete process.env.ZULIP_EMAIL;

      const existsSync = vi.fn((path: string | Buffer | URL) => {
        const value = String(path);
        return value === secretsEnvPath || value === fallbackEnvPath;
      });
      const readFileSync = vi.fn((path: string | Buffer | URL) => {
        if (String(path) === secretsEnvPath) {
          return "# bootstrap env\nZULIP_API_KEY=secret-key\nZULIP_EXISTING=override-attempt\n\nZULIP_EMAIL=bot@example.com\n";
        }
        return "ZULIP_API_KEY=fallback-key\n";
      });

      vi.resetModules();
      vi.doMock("node:fs", () => ({ existsSync, readFileSync }));

      try {
        const { default: rootPlugin } = await import("../index.js");

        rootPlugin.register({
          runtime: {
            config: {
              loadConfig: () => ({}),
            },
          },
          registerChannel: vi.fn(),
          registerTool: vi.fn(),
        } as never);

        expect(process.env.ZULIP_API_KEY).toBe("secret-key");
        expect(process.env.ZULIP_EMAIL).toBe("bot@example.com");
        expect(process.env.ZULIP_EXISTING).toBe("keep-me");
        expect(readFileSync).toHaveBeenCalledTimes(1);
        expect(readFileSync).toHaveBeenCalledWith(secretsEnvPath, "utf8");
      } finally {
        if (originalApiKey === undefined) {
          delete process.env.ZULIP_API_KEY;
        } else {
          process.env.ZULIP_API_KEY = originalApiKey;
        }
        if (originalEmail === undefined) {
          delete process.env.ZULIP_EMAIL;
        } else {
          process.env.ZULIP_EMAIL = originalEmail;
        }
        if (originalExisting === undefined) {
          delete process.env.ZULIP_EXISTING;
        } else {
          process.env.ZULIP_EXISTING = originalExisting;
        }

        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    });

    it("falls back to the secondary bootstrap env file when the first is missing", async () => {
      const secretsEnvPath = join(homedir(), ".openclaw", "secrets", "zulip.env");
      const fallbackEnvPath = join(homedir(), ".openclaw", "zulip.env");
      const originalApiKey = process.env.ZULIP_API_KEY;

      delete process.env.ZULIP_API_KEY;

      const existsSync = vi.fn((path: string | Buffer | URL) => String(path) === fallbackEnvPath);
      const readFileSync = vi.fn(() => "ZULIP_API_KEY=fallback-key\n");

      vi.resetModules();
      vi.doMock("node:fs", () => ({ existsSync, readFileSync }));

      try {
        const { default: rootPlugin } = await import("../index.js");
        rootPlugin.register({
          runtime: { config: { loadConfig: () => ({}) } },
          registerChannel: vi.fn(),
          registerTool: vi.fn(),
        } as never);

        expect(process.env.ZULIP_API_KEY).toBe("fallback-key");
        expect(existsSync).toHaveBeenCalledWith(secretsEnvPath);
        expect(readFileSync).toHaveBeenCalledWith(fallbackEnvPath, "utf8");
      } finally {
        if (originalApiKey === undefined) {
          delete process.env.ZULIP_API_KEY;
        } else {
          process.env.ZULIP_API_KEY = originalApiKey;
        }
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    });

    it("ignores unreadable bootstrap env files", async () => {
      const secretsEnvPath = join(homedir(), ".openclaw", "secrets", "zulip.env");
      const originalApiKey = process.env.ZULIP_API_KEY;

      delete process.env.ZULIP_API_KEY;

      const existsSync = vi.fn(() => true);
      const readFileSync = vi.fn(() => {
        throw new Error("permission denied");
      });

      vi.resetModules();
      vi.doMock("node:fs", () => ({ existsSync, readFileSync }));

      try {
        const { default: rootPlugin } = await import("../index.js");
        expect(() =>
          rootPlugin.register({
            runtime: { config: { loadConfig: () => ({}) } },
            registerChannel: vi.fn(),
            registerTool: vi.fn(),
          } as never),
        ).not.toThrow();
        expect(readFileSync).toHaveBeenCalledWith(secretsEnvPath, "utf8");
        expect(process.env.ZULIP_API_KEY).toBeUndefined();
      } finally {
        if (originalApiKey === undefined) {
          delete process.env.ZULIP_API_KEY;
        } else {
          process.env.ZULIP_API_KEY = originalApiKey;
        }
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    });

    it("formats allowFrom entries", () => {
      const formatAllowFrom = zulipPlugin.config.formatAllowFrom;
      const formatted = formatAllowFrom?.({
        cfg: {} as OpenClawConfig,
        allowFrom: ["@Alice", "user:USER123", "zulip:BOT999"],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            responsePrefix: "[Channel]",
            accounts: {
              default: { responsePrefix: "[Account]" },
            },
          },
        },
      };

      const prefixContext = createReplyPrefixOptions({
        cfg,
        agentId: "main",
        channel: "zulip",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });

    it("prefers account-level site/realm aliases over base-level url", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            url: "https://base.example.com",
            accounts: {
              default: {
                site: "https://account.example.com",
                realm: "https://account-realm.example.com",
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.baseUrl).toBe("https://account.example.com");
    });

    it("falls back to base-level aliases when account has no url aliases", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            site: "https://base-site.example.com",
            accounts: {
              default: {
                name: "Primary",
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.baseUrl).toBe("https://base-site.example.com");
    });

    it("treats {subscribed} as an exclusive stream token", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            enabled: true,
            baseUrl: "https://zulip.example.com",
            email: "bot@example.com",
            apiKey: "key",
            streams: ["general", SUBSCRIBED_TOKEN, "ops"],
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.streams).toEqual([SUBSCRIBED_TOKEN]);
    });

    it("uses configured defaultAccount for channel defaults", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            defaultAccount: "ops",
            accounts: {
              default: { name: "Default" },
              ops: { name: "Ops" },
            },
          },
        },
      };

      expect(zulipPlugin.config.defaultAccountId?.(cfg)).toBe("ops");
    });

    it("merges global and account action toggles", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            baseUrl: "https://zulip.example.com",
            email: "bot@example.com",
            apiKey: "key",
            actions: {
              "channel-create": true,
              "channel-edit": true,
            },
            accounts: {
              default: {
                actions: {
                  "channel-edit": false,
                  "channel-delete": true,
                },
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });

      expect(account.config.actions).toEqual({
        "channel-create": true,
        "channel-edit": false,
        "channel-delete": true,
      });
    });
  });

  it("normalizes emoji names", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
    expect(normalizeEmojiName("check")).toBe("check");
  });

  it("preserves stream topics containing separators in outbound targets", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["ops"],
        },
      },
    };

    await zulipPlugin.outbound?.sendPayload?.({
      to: "stream:ops#deploy:10/30",
      text: "Deploying now",
      payload: { text: "Deploying now" },
      cfg,
      accountId: "default",
    } as never);

    expect(sendMessageZulip).toHaveBeenCalledWith("stream:ops#deploy:10/30", "Deploying now", {
      accountId: "default",
    });
  });

  it("parses stream targets with optional topics", () => {
    expect(parseZulipTarget("stream:marcel-ai")).toEqual({ kind: "stream", stream: "marcel-ai" });
    expect(parseZulipTarget("zulip:stream:marcel-ai#deploy")).toEqual({
      kind: "stream",
      stream: "marcel-ai",
      topic: "deploy",
    });
  });

  it("applies defaultTopic when target omits topic", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          defaultTopic: "general chat",
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    const res = zulipPlugin.outbound?.resolveTarget?.({
      cfg,
      to: "stream:marcel-ai",
      accountId: account.accountId,
      mode: "explicit",
    });
    expect(res?.ok).toBe(true);
    if (res && res.ok) {
      expect(res.to).toBe("stream:marcel-ai#general chat");
    }
  });

  it("sendPayload sends text-only payloads through sendMessageZulip", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["ops"],
        },
      },
    };

    const result = await zulipPlugin.outbound?.sendPayload?.({
      to: "stream:ops#deploy",
      text: "Deploying now",
      payload: { text: "Deploying now" },
      cfg,
      accountId: "default",
    } as never);

    expect(sendMessageZulip).toHaveBeenCalledWith("stream:ops#deploy", "Deploying now", {
      accountId: "default",
    });
    expect(result).toEqual({ channel: "zulip", messageId: "100", channelId: "ops" });
  });

  it("sendPayload sends each media item and only includes text on the first one", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["ops"],
        },
      },
    };

    await zulipPlugin.outbound?.sendPayload?.({
      to: "stream:ops#deploy",
      text: "Artifacts",
      payload: {
        text: "Artifacts",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
      cfg,
      accountId: "default",
    } as never);

    expect(sendMessageZulip).toHaveBeenNthCalledWith(1, "stream:ops#deploy", "Artifacts", {
      accountId: "default",
      mediaUrl: "https://example.com/a.png",
    });
    expect(sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:ops#deploy", "", {
      accountId: "default",
      mediaUrl: "https://example.com/b.png",
    });
  });

  it("defaults to alwaysReply (no mention requirement)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
        },
      },
    };
    const requireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "marcel-ai",
    });
    expect(requireMention).toBe(false);
  });

  it("defaults to clearing the onStart reaction", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.clearOnFinish).toBe(true);
  });

  it("can leave the onStart reaction when clearOnFinish=false", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          reactions: {
            clearOnFinish: false,
          },
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.clearOnFinish).toBe(false);
  });

  it("enables workflow reactions by default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.workflow.enabled).toBe(true);
    expect(account.reactions.workflow.stages.queued).toBe(account.reactions.onStart);
    expect(account.reactions.workflow.stages.success).toBe(account.reactions.onSuccess);
    expect(account.reactions.workflow.stages.failure).toBe(account.reactions.onFailure);
  });

  it("supports opt-in workflow reactions with stage overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          reactions: {
            onStart: "eyes",
            onSuccess: "check",
            onFailure: "warning",
            workflow: {
              enabled: true,
              replaceStageReaction: false,
              minTransitionMs: 0,
              stages: {
                queued: "hourglass",
                toolRunning: "hammer",
                partialSuccess: "construction",
              },
            },
          },
        },
      },
    };

    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.workflow.enabled).toBe(true);
    expect(account.reactions.workflow.replaceStageReaction).toBe(false);
    expect(account.reactions.workflow.minTransitionMs).toBe(0);
    expect(account.reactions.workflow.stages.queued).toBe("hourglass");
    expect(account.reactions.workflow.stages.processing).toBe("eyes");
    expect(account.reactions.workflow.stages.toolRunning).toBe("hammer");
    expect(account.reactions.workflow.stages.partialSuccess).toBe("construction");
    expect(account.reactions.workflow.stages.failure).toBe("warning");
  });

  it("can require mentions when alwaysReply=false", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          alwaysReply: false,
        },
      },
    };
    const requireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "marcel-ai",
    });
    expect(requireMention).toBe(true);
  });

  it("resolves requireMention from chatmode defaults", () => {
    const onMessageCfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          chatmode: "onmessage",
        },
      },
    };
    const onCallCfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          chatmode: "oncall",
        },
      },
    };

    const onMessageRequireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg: onMessageCfg,
      groupId: "marcel-ai",
    });
    const onCallRequireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg: onCallCfg,
      groupId: "marcel-ai",
    });

    expect(onMessageRequireMention).toBe(false);
    expect(onCallRequireMention).toBe(true);
  });

  it("prefers explicit requireMention over chatmode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          chatmode: "onmessage",
          requireMention: true,
        },
      },
    };

    const requireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "marcel-ai",
    });
    expect(requireMention).toBe(true);
  });

  describe("root plugin tool registration", () => {
    it("registers a dedicated typing tool and dispatches stream typing", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const sendTypingSpy = vi.spyOn(zulipClient, "sendZulipTyping").mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_typing");

      expect(tool).toBeDefined();

      const result = await tool.execute("call-1", {
        op: "start",
        type: "stream",
        streamId: 42,
        topic: "deploy",
      });

      expect(sendTypingSpy).toHaveBeenCalledWith(expect.any(Object), {
        op: "start",
        type: "stream",
        streamId: 42,
        topic: "deploy",
      });
      expect(result.content[0].text).toContain("typing");

      const invalid = await tool.execute("call-2", {
        op: "start",
        type: "stream",
        streamId: 42,
      });
      expect(invalid.content[0].text).toContain("Error: topic is required");

      const invalidStreamId = await tool.execute("call-3", {
        op: "start",
        type: "stream",
        streamId: 0,
        topic: "deploy",
      });
      expect(invalidStreamId.content[0].text).toContain("Error: streamId must be a positive number");

      const direct = await tool.execute("call-4", {
        op: "stop",
        type: "direct",
        userIds: [7, "7", 9],
      });
      expect(sendTypingSpy).toHaveBeenCalledWith(expect.any(Object), {
        op: "stop",
        type: "direct",
        to: [7, 9],
      });
      expect(direct.content[0].text).toContain("users [7, 9]");

      const invalidDirect = await tool.execute("call-5", {
        op: "start",
        type: "direct",
        userIds: [7, "oops"],
      });
      expect(invalidDirect.content[0].text).toContain("Error: userIds must contain only positive numeric user ids");
    });

    it("registers reminders tool and supports list/create/delete actions", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const listRemindersSpy = vi.spyOn(zulipClient, "listZulipReminders").mockResolvedValue([
        {
          reminder_id: 44,
          reminder_target_message_id: 99,
          scheduled_delivery_timestamp: 1_710_000_000,
          content: "Follow up with ops",
        },
      ]);
      const createReminderSpy = vi.spyOn(zulipClient, "createZulipReminder").mockResolvedValue({
        reminder_id: 55,
      });
      const deleteReminderSpy = vi.spyOn(zulipClient, "deleteZulipReminder").mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_reminders");

      expect(tool).toBeDefined();

      const listResult = await tool.execute("call-1", { action: "list" });
      expect(listRemindersSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listResult.content[0].text).toContain("[44]");

      const createResult = await tool.execute("call-2", {
        action: "create",
        messageId: 99,
        scheduledAt: "2099-12-31T09:00:00Z",
        note: "Follow up with ops",
      });
      expect(createReminderSpy).toHaveBeenCalledWith(expect.any(Object), {
        messageId: 99,
        scheduledDeliveryTimestamp: Math.floor(new Date("2099-12-31T09:00:00Z").getTime() / 1000),
        note: "Follow up with ops",
      });
      expect(createResult.content[0].text).toContain("55");

      const deleteResult = await tool.execute("call-3", {
        action: "delete",
        reminderId: 55,
      });
      expect(deleteReminderSpy).toHaveBeenCalledWith(expect.any(Object), 55);
      expect(deleteResult.content[0].text).toContain("deleted");

      const invalidCreate = await tool.execute("call-4", {
        action: "create",
        messageId: 99,
      });
      expect(invalidCreate.content[0].text).toContain("Error: scheduledAt is required for create");

      const invalidPast = await tool.execute("call-5", {
        action: "create",
        messageId: 99,
        scheduledAt: "2001-01-01T00:00:00Z",
      });
      expect(invalidPast.content[0].text).toContain("Error: scheduledAt must be in the future");
    });

    it("adds DM filters and mark-all-read support to the messages tool", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const searchSpy = vi.spyOn(zulipClient, "getZulipMessagesAdvanced").mockResolvedValue({
        messages: [
          {
            id: 99,
            sender_full_name: "Alice",
            timestamp: 1_710_000_000,
            type: "private",
            display_recipient: [{ email: "alice@example.com" }],
            subject: "",
            content: "DM ping",
          } as never,
        ],
        found_oldest: true,
        found_newest: true,
        found_anchor: true,
      });
      const markAllReadSpy = vi
        .spyOn(zulipClient, "markAllZulipMessagesAsRead")
        .mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_messages");

      expect(tool).toBeDefined();

      const searchResult = await tool.execute("call-1", {
        action: "search",
        query: "deploy",
        dmWith: ["alice@example.com", "bob@example.com"],
      });
      expect(searchSpy).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          narrow: expect.arrayContaining([
            { operator: "search", operand: "deploy" },
            { operator: "dm", operand: "alice@example.com,bob@example.com" },
          ]),
        }),
      );
      expect(searchResult.content[0].text).toContain("99");

      const markResult = await tool.execute("call-2", {
        action: "mark_all_read",
      });
      expect(markAllReadSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(markResult.content[0].text).toContain("Marked all messages as read");
    });

    it("registers saved snippets tool and supports list/create/edit/delete actions", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const listSavedSnippetsSpy = vi.spyOn(zulipClient, "listZulipSavedSnippets").mockResolvedValue([
        {
          id: 7,
          title: "Deploy checklist",
          content: "1. build\n2. test\n3. deploy",
          date_created: 1_710_000_000,
        },
      ]);
      const createSavedSnippetSpy = vi
        .spyOn(zulipClient, "createZulipSavedSnippet")
        .mockResolvedValue({ id: 8 });
      const updateSavedSnippetSpy = vi
        .spyOn(zulipClient, "updateZulipSavedSnippet")
        .mockResolvedValue(undefined);
      const deleteSavedSnippetSpy = vi
        .spyOn(zulipClient, "deleteZulipSavedSnippet")
        .mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_saved_snippets");

      expect(tool).toBeDefined();

      const listResult = await tool.execute("call-1", { action: "list" });
      expect(listSavedSnippetsSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listResult.content[0].text).toContain("[7]");

      const createResult = await tool.execute("call-2", {
        action: "create",
        title: "Incident checklist",
        content: "1. acknowledge",
      });
      expect(createSavedSnippetSpy).toHaveBeenCalledWith(expect.any(Object), {
        title: "Incident checklist",
        content: "1. acknowledge",
      });
      expect(createResult.content[0].text).toContain("8");

      const editResult = await tool.execute("call-3", {
        action: "edit",
        snippetId: 8,
        title: "Incident runbook",
      });
      expect(updateSavedSnippetSpy).toHaveBeenCalledWith(expect.any(Object), 8, {
        title: "Incident runbook",
        content: undefined,
      });
      expect(editResult.content[0].text).toContain("updated");

      const deleteResult = await tool.execute("call-4", {
        action: "delete",
        snippetId: 8,
      });
      expect(deleteSavedSnippetSpy).toHaveBeenCalledWith(expect.any(Object), 8);
      expect(deleteResult.content[0].text).toContain("deleted");

      const invalidEdit = await tool.execute("call-5", {
        action: "edit",
        snippetId: 8,
      });
      expect(invalidEdit.content[0].text).toContain("Error: provide title and/or content for edit");

      const invalidCreate = await tool.execute("call-6", {
        action: "create",
        title: "Missing content",
      });
      expect(invalidCreate.content[0].text).toContain("Error: title and content are required for create");

      const invalidFractionalId = await tool.execute("call-7", {
        action: "delete",
        snippetId: 8.5,
      });
      expect(invalidFractionalId.content[0].text).toContain("Error: snippetId must be a positive integer");

      const invalidBlankEdit = await tool.execute("call-8", {
        action: "edit",
        snippetId: 8,
        title: "   ",
      });
      expect(invalidBlankEdit.content[0].text).toContain("Error: provide title and/or content for edit");
    });

    it("registers invitations tool and supports list/send/link/revoke/resend actions", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const listInvitationsSpy = vi.spyOn(zulipClient, "listZulipInvitations").mockResolvedValue({
        invites: [{ id: 44, email: "new.user@example.com", invited: 1_710_000_000 }],
        inviteLinks: [{ id: 66, linkUrl: "https://zulip.example.com/invite/abc" }],
      });
      const sendInvitationSpy = vi.spyOn(zulipClient, "sendZulipInvitation").mockResolvedValue(undefined);
      const createInviteLinkSpy = vi.spyOn(zulipClient, "createZulipInviteLink").mockResolvedValue({
        invite_link_url: "https://zulip.example.com/invite/xyz",
        id: 77,
      });
      const revokeInviteLinkSpy = vi
        .spyOn(zulipClient, "revokeZulipInviteLink")
        .mockResolvedValue(undefined);
      const revokeInvitationSpy = vi.spyOn(zulipClient, "revokeZulipInvitation").mockResolvedValue(undefined);
      const resendInvitationSpy = vi.spyOn(zulipClient, "resendZulipInvitation").mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_invitations");

      expect(tool).toBeDefined();

      const listResult = await tool.execute("call-1", { action: "list" });
      expect(listInvitationsSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listResult.content[0].text).toContain("new.user@example.com");
      expect(listResult.content[0].text).toContain("invite/abc");

      const sendResult = await tool.execute("call-2", {
        action: "send",
        emails: ["new.user@example.com"],
        streamIds: [3, 4],
      });
      expect(sendInvitationSpy).toHaveBeenCalledWith(expect.any(Object), {
        emails: ["new.user@example.com"],
        streamIds: [3, 4],
        inviteAs: undefined,
        includeRealmDefaultSubscriptions: undefined,
      });
      expect(sendResult.content[0].text).toContain("Invitation sent");

      const createLinkResult = await tool.execute("call-3", {
        action: "create_link",
        streamIds: [3],
        inviteAs: 400,
        inviteExpiresInMinutes: 60,
      });
      expect(createInviteLinkSpy).toHaveBeenCalledWith(expect.any(Object), {
        streamIds: [3],
        inviteAs: 400,
        inviteExpiresInMinutes: 60,
        includeRealmDefaultSubscriptions: undefined,
      });
      expect(createLinkResult.content[0].text).toContain("invite/xyz");

      const revokeLinkResult = await tool.execute("call-4", {
        action: "revoke_link",
        inviteLinkId: 77,
      });
      expect(revokeInviteLinkSpy).toHaveBeenCalledWith(expect.any(Object), 77);
      expect(revokeLinkResult.content[0].text).toContain("revoked");

      const revokeInviteResult = await tool.execute("call-5", {
        action: "revoke",
        inviteId: 44,
      });
      expect(revokeInvitationSpy).toHaveBeenCalledWith(expect.any(Object), 44);
      expect(revokeInviteResult.content[0].text).toContain("revoked");

      const resendResult = await tool.execute("call-6", {
        action: "resend",
        inviteId: 44,
      });
      expect(resendInvitationSpy).toHaveBeenCalledWith(expect.any(Object), 44);
      expect(resendResult.content[0].text).toContain("resent");

      const invalidSend = await tool.execute("call-7", {
        action: "send",
        emails: [],
      });
      expect(invalidSend.content[0].text).toContain("Error: emails is required");

      const invalidLinkId = await tool.execute("call-8", {
        action: "revoke_link",
        inviteLinkId: 0,
      });
      expect(invalidLinkId.content[0].text).toContain("Error: inviteLinkId must be a positive integer");

      const invalidStreams = await tool.execute("call-9", {
        action: "send",
        emails: ["new.user@example.com"],
        streamIds: [3, 4.5],
      });
      expect(invalidStreams.content[0].text).toContain("Error: streamIds must contain only positive integers");

      const invalidExpires = await tool.execute("call-10", {
        action: "create_link",
        inviteExpiresInMinutes: -5,
      });
      expect(invalidExpires.content[0].text).toContain("Error: inviteExpiresInMinutes must be a positive integer");

      const invalidInviteAs = await tool.execute("call-11", {
        action: "create_link",
        inviteAs: 500,
      });
      expect(invalidInviteAs.content[0].text).toContain("Error: inviteAs must be one of 100, 200, 300, 400, or 600");
    });

    it("registers code playground and default stream tools", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const listPlaygroundsSpy = vi.spyOn(zulipClient, "listZulipCodePlaygrounds").mockResolvedValue([
        {
          id: 5,
          name: "GitHub",
          pygments_language: "python",
          url_prefix: "https://github.com/",
        },
      ]);
      const addPlaygroundSpy = vi
        .spyOn(zulipClient, "addZulipCodePlayground")
        .mockResolvedValue({ id: 9 });
      const removePlaygroundSpy = vi
        .spyOn(zulipClient, "removeZulipCodePlayground")
        .mockResolvedValue(undefined);
      const listDefaultStreamsSpy = vi.spyOn(zulipClient, "listZulipDefaultStreams").mockResolvedValue([
        { stream_id: 12, name: "ops", description: "Ops stream" },
      ]);
      const addDefaultStreamSpy = vi
        .spyOn(zulipClient, "addZulipDefaultStream")
        .mockResolvedValue(undefined);
      const removeDefaultStreamSpy = vi
        .spyOn(zulipClient, "removeZulipDefaultStream")
        .mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const playgroundTool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_code_playgrounds");
      expect(playgroundTool).toBeDefined();

      const defaultStreamsTool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_default_streams");
      expect(defaultStreamsTool).toBeDefined();

      const listPlaygrounds = await playgroundTool.execute("call-1", { action: "list" });
      expect(listPlaygroundsSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listPlaygrounds.content[0].text).toContain("GitHub");

      const addPlayground = await playgroundTool.execute("call-2", {
        action: "add",
        name: "Sourcegraph",
        pygmentsLanguage: "typescript",
        urlPrefix: "https://sourcegraph.example.com/",
      });
      expect(addPlaygroundSpy).toHaveBeenCalledWith(expect.any(Object), {
        name: "Sourcegraph",
        pygmentsLanguage: "typescript",
        urlPrefix: "https://sourcegraph.example.com/",
      });
      expect(addPlayground.content[0].text).toContain("9");

      const removePlayground = await playgroundTool.execute("call-3", {
        action: "remove",
        playgroundId: 9,
      });
      expect(removePlaygroundSpy).toHaveBeenCalledWith(expect.any(Object), 9);
      expect(removePlayground.content[0].text).toContain("removed");

      const invalidPlayground = await playgroundTool.execute("call-4", {
        action: "add",
        name: "Sourcegraph",
        pygmentsLanguage: "typescript",
      });
      expect(invalidPlayground.content[0].text).toContain(
        "Error: name, pygmentsLanguage, and urlPrefix are required for add",
      );

      const listDefault = await defaultStreamsTool.execute("call-5", { action: "list" });
      expect(listDefaultStreamsSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listDefault.content[0].text).toContain("ops");

      const addDefault = await defaultStreamsTool.execute("call-6", {
        action: "add",
        streamId: 12,
      });
      expect(addDefaultStreamSpy).toHaveBeenCalledWith(expect.any(Object), 12);
      expect(addDefault.content[0].text).toContain("added");

      const removeDefault = await defaultStreamsTool.execute("call-7", {
        action: "remove",
        streamId: 12,
      });
      expect(removeDefaultStreamSpy).toHaveBeenCalledWith(expect.any(Object), 12);
      expect(removeDefault.content[0].text).toContain("removed");

      const invalidDefault = await defaultStreamsTool.execute("call-8", {
        action: "add",
      });
      expect(invalidDefault.content[0].text).toContain("Error: streamId or streamName is required for add");
    });

    it("registers attachments tool and validates delete attachment ids", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const listAttachmentsSpy = vi.spyOn(zulipClient, "listZulipAttachments").mockResolvedValue({
        attachments: [
          { id: 12, name: "incident.png", size: 2048, path_id: "abc", create_time: 1_710_000_000, messages: [] },
        ],
        uploadSpaceUsed: 2048,
      });
      const deleteAttachmentSpy = vi.spyOn(zulipClient, "deleteZulipAttachment").mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_attachments");
      expect(tool).toBeDefined();

      const listResult = await tool.execute("call-a1", { action: "list" });
      expect(listAttachmentsSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listResult.content[0].text).toContain("incident.png");

      const invalidDelete = await tool.execute("call-a2", { action: "delete", attachmentId: 12.5 });
      expect(invalidDelete.content[0].text).toContain("Error: attachmentId must be a positive integer");

      const deleteResult = await tool.execute("call-a3", { action: "delete", attachmentId: 12 });
      expect(deleteAttachmentSpy).toHaveBeenCalledWith(expect.any(Object), 12);
      expect(deleteResult.content[0].text).toContain("Attachment 12 deleted");
    });

    it("registers users tool admin and presence expansion actions", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const listUsersSpy = vi.spyOn(zulipClient, "listZulipUsers").mockResolvedValue([]);
      const fetchMeSpy = vi.spyOn(zulipClient, "fetchZulipMe").mockResolvedValue({
        id: "1",
        email: "bot@example.com",
        full_name: "Bot",
        is_admin: true,
      });
      const createUserSpy = vi.spyOn(zulipClient, "createZulipUser").mockResolvedValue(undefined);
      const updateUserSpy = vi.spyOn(zulipClient, "updateZulipUser").mockResolvedValue(undefined);
      const deactivateUserSpy = vi.spyOn(zulipClient, "deactivateZulipUser").mockResolvedValue(undefined);
      const reactivateUserSpy = vi.spyOn(zulipClient, "reactivateZulipUser").mockResolvedValue(undefined);
      const realmPresenceSpy = vi.spyOn(zulipClient, "getZulipRealmPresence").mockResolvedValue({
        "1": { website: { status: "active" } },
      });
      const setPresenceSpy = vi.spyOn(zulipClient, "setZulipOwnPresence").mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_users");

      expect(tool).toBeDefined();

      const listResult = await tool.execute("call-1", { action: "list" });
      expect(listUsersSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(listResult.content[0].text).toContain("No users found");

      const ownResult = await tool.execute("call-2", { action: "get_own" });
      expect(fetchMeSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(ownResult.content[0].text).toContain("bot@example.com");

      const createResult = await tool.execute("call-3", {
        action: "create",
        email: "new.user@example.com",
        fullName: "New User",
        password: "TempPass123!",
        role: 400,
      });
      expect(createUserSpy).toHaveBeenCalledWith(expect.any(Object), {
        email: "new.user@example.com",
        fullName: "New User",
        password: "TempPass123!",
        role: 400,
      });
      expect(createResult.content[0].text).toContain("created");

      const updateResult = await tool.execute("call-4", {
        action: "update",
        userId: 77,
        fullName: "Updated User",
        role: 600,
      });
      expect(updateUserSpy).toHaveBeenCalledWith(expect.any(Object), 77, {
        email: undefined,
        fullName: "Updated User",
        role: 600,
      });
      expect(updateResult.content[0].text).toContain("updated");

      const deactivateResult = await tool.execute("call-5", { action: "deactivate", userId: 77 });
      expect(deactivateUserSpy).toHaveBeenCalledWith(expect.any(Object), "77");
      expect(deactivateResult.content[0].text).toContain("deactivated");

      const reactivateResult = await tool.execute("call-6", { action: "reactivate", userId: 77 });
      expect(reactivateUserSpy).toHaveBeenCalledWith(expect.any(Object), "77");
      expect(reactivateResult.content[0].text).toContain("reactivated");

      const realmPresenceResult = await tool.execute("call-7", { action: "get_realm_presence" });
      expect(realmPresenceSpy).toHaveBeenCalledWith(expect.any(Object));
      expect(realmPresenceResult.content[0].text).toContain("website");

      const setPresenceResult = await tool.execute("call-8", {
        action: "set_presence",
        status: "active",
        pingOnly: true,
      });
      expect(setPresenceSpy).toHaveBeenCalledWith(expect.any(Object), { status: "active", pingOnly: true });
      expect(setPresenceResult.content[0].text).toContain("Presence updated");

      const invalidCreate = await tool.execute("call-9", {
        action: "create",
        email: "new.user@example.com",
      });
      expect(invalidCreate.content[0].text).toContain("Error: email, fullName, and password are required for create");

      const invalidSetPresence = await tool.execute("call-10", {
        action: "set_presence",
      });
      expect(invalidSetPresence.content[0].text).toContain("Error: status is required for set_presence unless pingOnly=true");

      const invalidUserId = await tool.execute("call-11", {
        action: "deactivate",
        userId: 77.5,
      });
      expect(invalidUserId.content[0].text).toContain("Error: userId must be a positive integer");

      const invalidRole = await tool.execute("call-12", {
        action: "create",
        email: "new.user@example.com",
        fullName: "New User",
        password: "TempPass123!",
        role: 400.5,
      });
      expect(invalidRole.content[0].text).toContain("Error: role must be a positive integer");
    });

    it("registers server settings tool profile write actions", async () => {
      vi.resetModules();
      const zulipClient = await import("./zulip/client.js");
      const createFieldSpy = vi
        .spyOn(zulipClient, "createZulipCustomProfileField")
        .mockResolvedValue({ id: 55 });
      const updateFieldSpy = vi
        .spyOn(zulipClient, "updateZulipCustomProfileField")
        .mockResolvedValue(undefined);
      const deleteFieldSpy = vi
        .spyOn(zulipClient, "deleteZulipCustomProfileField")
        .mockResolvedValue(undefined);
      const reorderFieldsSpy = vi
        .spyOn(zulipClient, "reorderZulipCustomProfileFields")
        .mockResolvedValue(undefined);
      const updateProfileDataSpy = vi
        .spyOn(zulipClient, "updateZulipUserProfileData")
        .mockResolvedValue(undefined);
      const registerTool = vi.fn();

      const { default: rootPlugin } = await import("../index.js");
      rootPlugin.register({
        runtime: {
          config: {
            loadConfig: () => ({
              channels: {
                zulip: {
                  enabled: true,
                  baseUrl: "https://zulip.example.com",
                  email: "bot@example.com",
                  apiKey: "key",
                  streams: ["ops"],
                },
              },
            }),
          },
        },
        registerChannel: vi.fn(),
        registerTool,
      } as never);

      const tool = registerTool.mock.calls
        .map(([registered]) => registered)
        .find((registered) => registered?.name === "zulip_server_settings");

      expect(tool).toBeDefined();

      const createResult = await tool.execute("call-1", {
        action: "profile_fields_create",
        name: "Pager",
        fieldType: 1,
        hint: "Primary pager number",
        fieldData: '{"format":"phone"}',
        displayInProfileSummary: true,
      });
      expect(createFieldSpy).toHaveBeenCalledWith(expect.any(Object), {
        name: "Pager",
        fieldType: 1,
        hint: "Primary pager number",
        fieldData: '{"format":"phone"}',
        displayInProfileSummary: true,
      });
      expect(createResult.content[0].text).toContain("created");

      const updateResult = await tool.execute("call-2", {
        action: "profile_fields_update",
        fieldId: 55,
        name: "Primary pager",
        hint: "Rotation phone",
        displayInProfileSummary: false,
      });
      expect(updateFieldSpy).toHaveBeenCalledWith(expect.any(Object), 55, {
        name: "Primary pager",
        fieldType: undefined,
        hint: "Rotation phone",
        fieldData: undefined,
        displayInProfileSummary: false,
      });
      expect(updateResult.content[0].text).toContain("updated");

      const deleteResult = await tool.execute("call-3", {
        action: "profile_fields_delete",
        fieldId: 55,
      });
      expect(deleteFieldSpy).toHaveBeenCalledWith(expect.any(Object), 55);
      expect(deleteResult.content[0].text).toContain("deleted");

      const reorderResult = await tool.execute("call-4", {
        action: "profile_fields_reorder",
        order: [2, 1, 3],
      });
      expect(reorderFieldsSpy).toHaveBeenCalledWith(expect.any(Object), [2, 1, 3]);
      expect(reorderResult.content[0].text).toContain("reordered");

      const updateProfileResult = await tool.execute("call-5", {
        action: "user_profile_update",
        userId: 77,
        data: [
          { id: 2, value: "On-call this week" },
          { id: 3, value: "UTC-5" },
        ],
      });
      expect(updateProfileDataSpy).toHaveBeenCalledWith(expect.any(Object), 77, [
        { id: 2, value: "On-call this week" },
        { id: 3, value: "UTC-5" },
      ]);
      expect(updateProfileResult.content[0].text).toContain("profile data updated");

      const invalidUpdate = await tool.execute("call-6", {
        action: "profile_fields_update",
        name: "Missing id",
      });
      expect(invalidUpdate.content[0].text).toContain("Error: fieldId is required");

      const invalidData = await tool.execute("call-7", {
        action: "user_profile_update",
        userId: 77,
        data: [],
      });
      expect(invalidData.content[0].text).toContain("Error: data must contain at least one profile field update");

      const invalidReorder = await tool.execute("call-8", {
        action: "profile_fields_reorder",
        order: [2, 1.5],
      });
      expect(invalidReorder.content[0].text).toContain("Error: order must contain only positive integers");
    });
  });
});
