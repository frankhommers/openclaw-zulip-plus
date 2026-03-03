import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import { SUBSCRIBED_TOKEN } from "./types.js";
import { resolveZulipAccount } from "./zulip/accounts.js";
import { normalizeEmojiName } from "./zulip/normalize.js";
import { parseZulipTarget } from "./zulip/targets.js";

describe("zulipPlugin", () => {
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
  });

  it("normalizes emoji names", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
    expect(normalizeEmojiName("check")).toBe("check");
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
});
