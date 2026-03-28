import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import { resolveZulipAccount } from "./zulip/accounts.js";

export function resolveZulipGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolveZulipAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.requireMention === "boolean") {
    return account.requireMention;
  }
  if (typeof account.config.alwaysReply === "boolean") {
    return !account.config.alwaysReply;
  }
  if (account.chatmode === "oncall") {
    return true;
  }
  if (account.chatmode === "onmessage") {
    return false;
  }
  return false;
}
