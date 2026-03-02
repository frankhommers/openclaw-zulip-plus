import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./zulip/accounts.js";

export function resolveZulipGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolveZulipAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.requireMention === "boolean") {
    return account.requireMention;
  }
  if (account.chatmode === "oncall") {
    return true;
  }
  if (account.chatmode === "onmessage") {
    return false;
  }
  if (typeof account.alwaysReply === "boolean") {
    return !account.alwaysReply;
  }
  return false;
}
