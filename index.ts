import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zulipPlugin } from "./src/channel.js";
import { setZulipRuntime } from "./src/runtime.js";
import { resolveZulipAccount } from "./src/zulip/accounts.js";
import * as zulip from "./src/zulip/client.js";

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return { content: [{ type: "text", text }], details: {} };
}

function getClient(cfg: OpenClawConfig): zulip.ZulipClient {
  const account = resolveZulipAccount({ cfg });
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Zulip account not configured (missing baseUrl, email, or apiKey)");
  }
  return zulip.createZulipClient({
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
  });
}

async function findStreamByName(client: zulip.ZulipClient, streamName: string) {
  const subs = await zulip.fetchZulipSubscriptions(client);
  const found = subs.find((s) => s.name?.toLowerCase() === streamName.toLowerCase());
  if (found?.stream_id) {
    return { stream_id: found.stream_id, name: found.name ?? streamName };
  }
  const allStreams = await zulip.fetchZulipStreams(client);
  const publicFound = allStreams.find((s) => s.name?.toLowerCase() === streamName.toLowerCase());
  if (publicFound) {
    return { stream_id: Number(publicFound.id), name: publicFound.name ?? streamName };
  }
  throw new Error(`Stream not found: ${streamName}`);
}

function formatUserDetails(user: {
  full_name?: string | null;
  user_id?: number;
  id?: string;
  email?: string | null;
  is_active?: boolean;
  is_bot?: boolean;
  timezone?: string | null;
  date_joined?: string | null;
}): string {
  const userId = user.user_id ?? Number(user.id);
  return [
    `Name: ${user.full_name ?? "(unknown)"}`,
    Number.isFinite(userId) ? `ID: ${userId}` : null,
    user.email ? `Email: ${user.email}` : null,
    typeof user.is_active === "boolean" ? `Active: ${user.is_active ? "Yes" : "No"}` : null,
    typeof user.is_bot === "boolean" ? `Bot: ${user.is_bot ? "Yes" : "No"}` : null,
    user.timezone ? `Timezone: ${user.timezone}` : null,
    user.date_joined ? `Joined: ${user.date_joined}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatMessageDetails(msg: zulip.ZulipMessageDetails): string {
  const date = new Date(msg.timestamp * 1000).toISOString();
  const location =
    msg.type === "stream"
      ? `#${typeof msg.display_recipient === "string" ? msg.display_recipient : "?"} > ${msg.subject}`
      : "DM";
  const preview = msg.content.length > 300 ? `${msg.content.slice(0, 300)}...` : msg.content;
  return `[${msg.id}] ${msg.sender_full_name} (${date}) in ${location}:\n${preview}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const nums = value.map((entry) => asNumber(entry)).filter((entry): entry is number => entry != null);
  return nums;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
}

function getAction(params: Record<string, unknown>): string {
  const action = asString(params.action);
  if (!action) {
    throw new Error("action is required");
  }
  return action;
}

function parseDateToEpochSeconds(input: string): number {
  const ts = Math.floor(new Date(input).getTime() / 1000);
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error("invalid datetime");
  }
  return ts;
}

const plugin = {
  id: "zulip",
  name: "Zulip",
  description: "Zulip channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZulipRuntime(api.runtime);
    api.registerChannel({ plugin: zulipPlugin });

    api.registerTool({
      name: "zulip_streams",
      label: "Zulip Streams",
      description: "List and manage Zulip streams, topics, memberships, and subscribers.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list_all",
              "list_subscribed",
              "create",
              "join",
              "leave",
              "update",
              "delete",
              "topics",
              "members",
              "subscribe_users",
              "unsubscribe_users",
            ],
          },
          name: { type: "string" },
          streamName: { type: "string" },
          streamId: { type: "number" },
          description: { type: "string" },
          isPrivate: { type: "boolean" },
          isWebPublic: { type: "boolean" },
          isDefaultStream: { type: "boolean" },
          historyPublicToSubscribers: { type: "boolean" },
          userIds: { type: "array", items: { type: "number" } },
          newName: { type: "string" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list_all") {
            const streams = await zulip.fetchZulipStreams(client);
            const lines = streams.map((s) => `- ${s.name ?? "(unnamed)"} (id:${s.id})`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No streams found.");
          }

          if (action === "list_subscribed") {
            const subs = await zulip.fetchZulipSubscriptions(client);
            const lines = subs.map((s) => `- ${s.name ?? "(unnamed)"} (id:${s.stream_id ?? "?"})`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No subscribed streams.");
          }

          if (action === "create" || action === "join") {
            const name = asString(params.name) ?? asString(params.streamName);
            if (!name) {
              throw new Error("name is required");
            }
            await zulip.subscribeZulipStream(client, name);
            return textResult(`${action === "create" ? "Created/joined" : "Joined"} stream ${name}.`);
          }

          if (action === "leave") {
            const name = asString(params.name) ?? asString(params.streamName);
            if (!name) {
              throw new Error("name is required");
            }
            await zulip.unsubscribeZulipStream(client, name);
            return textResult(`Left stream ${name}.`);
          }

          if (action === "update") {
            const streamId = asNumber(params.streamId);
            const streamName = asString(params.streamName) ?? asString(params.name);
            const resolvedId = streamId ?? (streamName ? (await findStreamByName(client, streamName)).stream_id : undefined);
            if (!resolvedId) {
              throw new Error("streamId or streamName is required");
            }
            await zulip.updateZulipStream(client, {
              streamId: String(resolvedId),
              description: asString(params.description),
              newName: asString(params.newName),
              isPrivate: asBoolean(params.isPrivate),
              isWebPublic: asBoolean(params.isWebPublic),
              isDefaultStream: asBoolean(params.isDefaultStream),
              historyPublicToSubscribers: asBoolean(params.historyPublicToSubscribers),
            });
            return textResult(`Stream ${resolvedId} updated.`);
          }

          if (action === "delete") {
            const streamId = asNumber(params.streamId);
            const streamName = asString(params.streamName) ?? asString(params.name);
            const resolvedId = streamId ?? (streamName ? (await findStreamByName(client, streamName)).stream_id : undefined);
            if (!resolvedId) {
              throw new Error("streamId or streamName is required");
            }
            await zulip.deleteZulipStream(client, String(resolvedId));
            return textResult(`Stream ${resolvedId} deleted.`);
          }

          if (action === "topics") {
            const streamId = asNumber(params.streamId);
            const streamName = asString(params.streamName) ?? asString(params.name);
            const resolved = streamId
              ? { stream_id: streamId, name: streamName ?? String(streamId) }
              : streamName
                ? await findStreamByName(client, streamName)
                : undefined;
            if (!resolved) {
              throw new Error("streamId or streamName is required");
            }
            const topics = await zulip.getZulipStreamTopics(client, resolved.stream_id);
            const lines = topics.map((topic) => `- ${topic.name} (max_id:${topic.max_id})`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No topics found.");
          }

          if (action === "members") {
            const streamId = asNumber(params.streamId);
            const streamName = asString(params.streamName) ?? asString(params.name);
            const resolved = streamId
              ? { stream_id: streamId, name: streamName ?? String(streamId) }
              : streamName
                ? await findStreamByName(client, streamName)
                : undefined;
            if (!resolved) {
              throw new Error("streamId or streamName is required");
            }
            const members = await zulip.getZulipStreamMembers(client, resolved.stream_id);
            return textResult(`Members (${members.length}): ${members.join(", ")}`);
          }

          if (action === "subscribe_users") {
            const name = asString(params.name) ?? asString(params.streamName);
            const userIds = asNumberArray(params.userIds) ?? [];
            if (!name || userIds.length === 0) {
              throw new Error("name/streamName and non-empty userIds are required");
            }
            const result = await zulip.subscribeUsersToZulipStream(client, {
              name,
              userIds: [...new Set(userIds)].map((n) => Math.trunc(n)),
              description: asString(params.description),
              isPrivate: asBoolean(params.isPrivate),
            });
            return textResult(
              `Subscribed users in ${name}. subscribed=${Object.values(result.subscribed).flat().length}, already=${Object.values(result.already_subscribed).flat().length}.`,
            );
          }

          if (action === "unsubscribe_users") {
            const name = asString(params.name) ?? asString(params.streamName);
            const userIds = asNumberArray(params.userIds) ?? [];
            if (!name || userIds.length === 0) {
              throw new Error("name/streamName and non-empty userIds are required");
            }
            await zulip.unsubscribeUsersFromZulipStream(
              client,
              name,
              [...new Set(userIds)].map((n) => Math.trunc(n)),
            );
            return textResult(`Unsubscribed ${userIds.length} users from ${name}.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_send",
      label: "Zulip Send",
      description: "Send stream, direct, or group direct messages in Zulip.",
      parameters: {
        type: "object",
        properties: {
          streamName: { type: "string" },
          topic: { type: "string" },
          userId: { type: "number" },
          userIds: { type: "array", items: { type: "number" } },
          content: { type: "string" },
        },
        required: ["content"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const streamName = asString(params.streamName);
          const userId = asNumber(params.userId);
          const userIds = asNumberArray(params.userIds);
          const content = asString(params.content);
          if (!content) {
            throw new Error("content is required");
          }

          if (streamName) {
            const topic = asString(params.topic) ?? "(no topic)";
            const sent = await zulip.sendZulipApiMessage(client, {
              type: "stream",
              to: streamName,
              topic,
              content,
            });
            return textResult(`Sent stream message id:${sent.id} to #${streamName} > ${topic}.`);
          }

          if (userIds && userIds.length > 0) {
            const unique = [...new Set(userIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
            if (unique.length < 2) {
              throw new Error("userIds must contain at least 2 distinct users");
            }
            const sent = await zulip.sendZulipApiMessage(client, {
              type: "direct",
              to: JSON.stringify(unique),
              content,
            });
            return textResult(`Sent group DM id:${sent.id} to users [${unique.join(", ")}].`);
          }

          if (userId) {
            if (userId <= 0) {
              throw new Error("userId must be positive");
            }
            const sent = await zulip.sendZulipApiMessage(client, {
              type: "direct",
              to: JSON.stringify([Math.trunc(userId)]),
              content,
            });
            return textResult(`Sent DM id:${sent.id} to user ${Math.trunc(userId)}.`);
          }

          throw new Error("provide streamName, userId, or userIds");
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_users",
      label: "Zulip Users",
      description: "List users, fetch user details, and check user presence.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "get_by_email", "presence"] },
          userId: { type: "number" },
          email: { type: "string" },
          includeDeactivated: { type: "boolean" },
          includeBots: { type: "boolean" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const users = await zulip.listZulipUsers(client);
            const includeDeactivated = asBoolean(params.includeDeactivated) === true;
            const includeBots = asBoolean(params.includeBots) === true;
            const filtered = users.filter((user) => {
              if (!includeDeactivated && !user.is_active) {
                return false;
              }
              if (!includeBots && user.is_bot) {
                return false;
              }
              return true;
            });
            const lines = filtered.map(
              (user) =>
                `- ${user.full_name} (id:${user.user_id}, email:${user.email})${user.is_bot ? " [bot]" : ""}${!user.is_active ? " [deactivated]" : ""}`,
            );
            return textResult(lines.length > 0 ? lines.join("\n") : "No users found.");
          }

          if (action === "get") {
            const userId = asNumber(params.userId);
            if (!userId) {
              throw new Error("userId is required for get");
            }
            const user = await zulip.fetchZulipUser(client, String(Math.trunc(userId)));
            return textResult(formatUserDetails(user));
          }

          if (action === "get_by_email") {
            const email = asString(params.email);
            if (!email) {
              throw new Error("email is required for get_by_email");
            }
            const user = await zulip.getZulipUserByEmail(client, email);
            return textResult(formatUserDetails(user));
          }

          if (action === "presence") {
            const userId = asNumber(params.userId);
            const email = asString(params.email);
            const key = userId ? String(Math.trunc(userId)) : email;
            if (!key) {
              throw new Error("userId or email is required for presence");
            }
            const presence = await zulip.fetchZulipUserPresence(client, key);
            const entries = Object.entries(presence);
            if (entries.length === 0) {
              return textResult(`No presence data for ${key}.`);
            }
            const lines = entries.map(([clientName, info]) => {
              const ts = info.timestamp ? new Date(info.timestamp * 1000).toISOString() : "unknown";
              return `- ${clientName}: ${info.status ?? "unknown"} (last seen: ${ts})`;
            });
            return textResult(lines.join("\n"));
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_messages",
      label: "Zulip Messages",
      description: "Get, search, edit, delete, and react to Zulip messages.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get", "search", "edit", "delete", "add_reaction", "remove_reaction"],
          },
          messageId: { type: "number" },
          query: { type: "string" },
          streamName: { type: "string" },
          topic: { type: "string" },
          senderId: { type: "number" },
          limit: { type: "number" },
          anchor: { type: ["number", "string"] },
          before: { type: "number" },
          after: { type: "number" },
          includeAnchor: { type: "boolean" },
          content: { type: "string" },
          newTopic: { type: "string" },
          propagateMode: { type: "string", enum: ["change_one", "change_later", "change_all"] },
          emojiName: { type: "string" },
          emojiCode: { type: "string" },
          reactionType: { type: "string" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "get") {
            const messageId = asNumber(params.messageId);
            if (!messageId) {
              throw new Error("messageId is required for get");
            }
            const message = await zulip.getZulipSingleMessage(client, Math.trunc(messageId));
            return textResult(formatMessageDetails(message));
          }

          if (action === "search") {
            const narrow: Array<Record<string, unknown>> = [];
            const streamName = asString(params.streamName);
            const topic = asString(params.topic);
            const senderId = asNumber(params.senderId);
            const query = asString(params.query);
            if (streamName) {
              narrow.push({ operator: "stream", operand: streamName });
            }
            if (topic) {
              narrow.push({ operator: "topic", operand: topic });
            }
            if (senderId) {
              narrow.push({ operator: "sender", operand: Math.trunc(senderId) });
            }
            if (query) {
              narrow.push({ operator: "search", operand: query });
            }
            const limit = Math.min(Math.max(Math.trunc(asNumber(params.limit) ?? 20), 1), 100);
            const anchorRaw = params.anchor;
            let anchor: number | string = "newest";
            if (typeof anchorRaw === "string" || typeof anchorRaw === "number") {
              const parsed = asNumber(anchorRaw);
              if (parsed != null) {
                anchor = Math.trunc(parsed);
              } else {
                anchor = String(anchorRaw);
              }
            }

            const beforeParam = asNumber(params.before);
            const afterParam = asNumber(params.after);
            let numBefore: number;
            let numAfter: number;
            if (beforeParam != null || afterParam != null) {
              numBefore = Math.max(0, Math.trunc(beforeParam ?? 0));
              numAfter = Math.max(0, Math.trunc(afterParam ?? 0));
            } else if (anchor === "oldest") {
              numBefore = 0;
              numAfter = limit;
            } else {
              numBefore = limit;
              numAfter = 0;
            }

            const result = await zulip.getZulipMessagesAdvanced(client, {
              anchor,
              numBefore,
              numAfter,
              narrow: narrow.length > 0 ? narrow : undefined,
              includeAnchor: asBoolean(params.includeAnchor),
            });

            if (result.messages.length === 0) {
              return textResult("No messages found.");
            }
            const lines = result.messages.map((m) => formatMessageDetails(m));
            return textResult(`${result.messages.length} message(s):\n\n${lines.join("\n\n---\n\n")}`);
          }

          if (action === "edit") {
            const messageId = asNumber(params.messageId);
            if (!messageId) {
              throw new Error("messageId is required for edit");
            }
            const content = asString(params.content);
            const newTopic = asString(params.newTopic);
            if (!content && !newTopic) {
              throw new Error("provide content and/or newTopic for edit");
            }
            await zulip.updateZulipMessageContent(client, Math.trunc(messageId), {
              content,
              topic: newTopic,
              propagateMode: asString(params.propagateMode) as "change_one" | "change_later" | "change_all" | undefined,
            });
            return textResult(`Message ${Math.trunc(messageId)} updated.`);
          }

          if (action === "delete") {
            const messageId = asNumber(params.messageId);
            if (!messageId) {
              throw new Error("messageId is required for delete");
            }
            await zulip.deleteZulipMessage(client, { messageId: String(Math.trunc(messageId)) });
            return textResult(`Message ${Math.trunc(messageId)} deleted.`);
          }

          if (action === "add_reaction") {
            const messageId = asNumber(params.messageId);
            const emojiName = asString(params.emojiName);
            if (!messageId || !emojiName) {
              throw new Error("messageId and emojiName are required for add_reaction");
            }
            await zulip.addZulipReactionViaClient(client, {
              messageId: String(Math.trunc(messageId)),
              emojiName,
              emojiCode: asString(params.emojiCode),
              reactionType: asString(params.reactionType),
            });
            return textResult(`Added :${emojiName}: to message ${Math.trunc(messageId)}.`);
          }

          if (action === "remove_reaction") {
            const messageId = asNumber(params.messageId);
            const emojiName = asString(params.emojiName);
            if (!messageId || !emojiName) {
              throw new Error("messageId and emojiName are required for remove_reaction");
            }
            await zulip.removeZulipReactionViaClient(client, {
              messageId: String(Math.trunc(messageId)),
              emojiName,
              emojiCode: asString(params.emojiCode),
              reactionType: asString(params.reactionType),
            });
            return textResult(`Removed :${emojiName}: from message ${Math.trunc(messageId)}.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_scheduled_messages",
      label: "Zulip Scheduled Messages",
      description: "List and manage scheduled Zulip messages.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "edit", "delete"] },
          scheduledMessageId: { type: "number" },
          streamName: { type: "string" },
          topic: { type: "string" },
          userId: { type: "number" },
          content: { type: "string" },
          scheduledAt: { type: "string" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const scheduled = await zulip.listZulipScheduledMessages(client);
            if (scheduled.length === 0) {
              return textResult("No scheduled messages.");
            }
            const lines = scheduled.map((item) => {
              const at = new Date(item.scheduled_delivery_timestamp * 1000).toISOString();
              return `- [${item.scheduled_message_id}] type=${item.type}, to=${JSON.stringify(item.to)}, at=${at}`;
            });
            return textResult(lines.join("\n"));
          }

          if (action === "create") {
            const content = asString(params.content);
            const scheduledAt = asString(params.scheduledAt);
            if (!content || !scheduledAt) {
              throw new Error("content and scheduledAt are required for create");
            }
            const scheduledDeliveryTimestamp = parseDateToEpochSeconds(scheduledAt);
            if (scheduledDeliveryTimestamp <= Math.floor(Date.now() / 1000)) {
              throw new Error("scheduledAt must be in the future");
            }
            const streamName = asString(params.streamName);
            const userId = asNumber(params.userId);
            if (streamName && userId) {
              throw new Error("provide only streamName or userId");
            }

            if (streamName) {
              const stream = await findStreamByName(client, streamName);
              const res = await zulip.createZulipScheduledMessage(client, {
                type: "stream",
                to: String(stream.stream_id),
                topic: asString(params.topic) ?? "(no topic)",
                content,
                scheduledDeliveryTimestamp,
              });
              return textResult(`Scheduled stream message ${res.scheduled_message_id}.`);
            }

            if (!userId || userId <= 0) {
              throw new Error("userId is required for DM scheduled message");
            }

            const res = await zulip.createZulipScheduledMessage(client, {
              type: "private",
              to: JSON.stringify([Math.trunc(userId)]),
              content,
              scheduledDeliveryTimestamp,
            });
            return textResult(`Scheduled DM ${res.scheduled_message_id}.`);
          }

          if (action === "edit") {
            const scheduledMessageId = asNumber(params.scheduledMessageId);
            if (!scheduledMessageId) {
              throw new Error("scheduledMessageId is required for edit");
            }
            const updates: {
              type?: "stream" | "private";
              to?: string;
              topic?: string;
              content?: string;
              scheduledDeliveryTimestamp?: number;
            } = {};
            const content = asString(params.content);
            if (content) {
              updates.content = content;
            }
            const topic = asString(params.topic);
            if (topic) {
              updates.topic = topic;
            }
            const scheduledAt = asString(params.scheduledAt);
            if (scheduledAt) {
              updates.scheduledDeliveryTimestamp = parseDateToEpochSeconds(scheduledAt);
            }
            const streamName = asString(params.streamName);
            const userId = asNumber(params.userId);
            if (streamName && userId) {
              throw new Error("provide only streamName or userId");
            }
            if (streamName) {
              const stream = await findStreamByName(client, streamName);
              updates.type = "stream";
              updates.to = String(stream.stream_id);
              updates.topic = topic ?? "(no topic)";
            } else if (userId) {
              updates.type = "private";
              updates.to = JSON.stringify([Math.trunc(userId)]);
            }
            await zulip.updateZulipScheduledMessage(client, Math.trunc(scheduledMessageId), updates);
            return textResult(`Scheduled message ${Math.trunc(scheduledMessageId)} updated.`);
          }

          if (action === "delete") {
            const scheduledMessageId = asNumber(params.scheduledMessageId);
            if (!scheduledMessageId) {
              throw new Error("scheduledMessageId is required for delete");
            }
            await zulip.deleteZulipScheduledMessage(client, Math.trunc(scheduledMessageId));
            return textResult(`Scheduled message ${Math.trunc(scheduledMessageId)} deleted.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_user_groups",
      label: "Zulip User Groups",
      description: "List and manage Zulip user groups and members.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "update", "delete", "members", "add_members", "remove_members"],
          },
          groupId: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          members: { type: "array", items: { type: "number" } },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const groups = (await zulip.listZulipUserGroups(client)).filter((g) => !g.is_system_group);
            const lines = groups.map((g) => `- ${g.name} (id:${g.id}) members:${g.members.length}`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No user groups found.");
          }

          if (action === "create") {
            const name = asString(params.name);
            if (!name) {
              throw new Error("name is required for create");
            }
            await zulip.createZulipUserGroup(client, {
              name,
              description: asString(params.description),
              members: (asNumberArray(params.members) ?? []).map((n) => Math.trunc(n)),
            });
            return textResult(`User group ${name} created.`);
          }

          if (action === "update") {
            const groupId = asNumber(params.groupId);
            if (!groupId) {
              throw new Error("groupId is required for update");
            }
            await zulip.updateZulipUserGroup(client, Math.trunc(groupId), {
              name: asString(params.name),
              description: asString(params.description),
            });
            return textResult(`User group ${Math.trunc(groupId)} updated.`);
          }

          if (action === "delete") {
            const groupId = asNumber(params.groupId);
            if (!groupId) {
              throw new Error("groupId is required for delete");
            }
            await zulip.deleteZulipUserGroup(client, Math.trunc(groupId));
            return textResult(`User group ${Math.trunc(groupId)} deleted.`);
          }

          if (action === "members") {
            const groupId = asNumber(params.groupId);
            if (!groupId) {
              throw new Error("groupId is required for members");
            }
            const members = await zulip.getZulipUserGroupMembers(client, Math.trunc(groupId));
            return textResult(`Members (${members.length}): ${members.join(", ")}`);
          }

          if (action === "add_members" || action === "remove_members") {
            const groupId = asNumber(params.groupId);
            const members = (asNumberArray(params.members) ?? []).map((n) => Math.trunc(n));
            if (!groupId || members.length === 0) {
              throw new Error("groupId and non-empty members are required");
            }
            await zulip.updateZulipUserGroupMembers(client, Math.trunc(groupId), {
              add: action === "add_members" ? members : undefined,
              remove: action === "remove_members" ? members : undefined,
            });
            return textResult(`${action === "add_members" ? "Added" : "Removed"} ${members.length} members.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_custom_emoji",
      label: "Zulip Custom Emoji",
      description: "List, upload, and deactivate custom Zulip emoji.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "upload", "deactivate"] },
          emojiName: { type: "string" },
          imageUrl: { type: "string" },
          includeDeactivated: { type: "boolean" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const includeDeactivated = asBoolean(params.includeDeactivated) === true;
            const all = await zulip.listZulipCustomEmoji(client);
            const filtered = includeDeactivated ? all : all.filter((emoji) => !emoji.deactivated);
            const lines = filtered.map((emoji) => `- :${emoji.name}: id:${emoji.id}${emoji.deactivated ? " [deactivated]" : ""}`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No custom emoji found.");
          }

          if (action === "upload") {
            const emojiName = asString(params.emojiName);
            const imageUrl = asString(params.imageUrl);
            if (!emojiName || !imageUrl) {
              throw new Error("emojiName and imageUrl are required for upload");
            }
            const response = await fetch(imageUrl);
            if (!response.ok) {
              throw new Error(`failed to fetch image URL (${response.status})`);
            }
            const contentType = response.headers.get("content-type") ?? "application/octet-stream";
            const imageBuffer = Buffer.from(await response.arrayBuffer());
            const extMap: Record<string, string> = {
              "image/png": ".png",
              "image/gif": ".gif",
              "image/jpeg": ".jpg",
              "image/webp": ".webp",
            };
            const ext = extMap[contentType.split(";")[0].trim()] ?? ".bin";
            await zulip.uploadZulipCustomEmoji(client, emojiName, imageBuffer, `${emojiName}${ext}`, contentType);
            return textResult(`Uploaded custom emoji :${emojiName}:.`);
          }

          if (action === "deactivate") {
            const emojiName = asString(params.emojiName);
            if (!emojiName) {
              throw new Error("emojiName is required for deactivate");
            }
            const all = await zulip.listZulipCustomEmoji(client);
            const target = all.find((emoji) => emoji.name === emojiName && !emoji.deactivated);
            if (!target) {
              throw new Error(`active emoji not found: ${emojiName}`);
            }
            await zulip.deactivateZulipCustomEmoji(client, target.id);
            return textResult(`Deactivated custom emoji :${emojiName}:.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_drafts",
      label: "Zulip Drafts",
      description: "List and manage Zulip drafts.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "edit", "delete"] },
          draftId: { type: "number" },
          streamName: { type: "string" },
          topic: { type: "string" },
          userId: { type: "number" },
          content: { type: "string" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const drafts = await zulip.listZulipDrafts(client);
            if (drafts.length === 0) {
              return textResult("No drafts found.");
            }
            const streamMap = new Map((await zulip.fetchZulipStreams(client)).map((s) => [Number(s.id), s.name ?? s.id]));
            const lines = drafts.map((draft) => {
              const when = new Date(draft.timestamp * 1000).toISOString();
              if (draft.type === "stream") {
                const streamId = draft.to[0];
                const streamName = streamMap.get(streamId) ?? String(streamId);
                return `- [${draft.id}] #${streamName} > ${draft.topic} (${when})`;
              }
              return `- [${draft.id}] DM to ${JSON.stringify(draft.to)} (${when})`;
            });
            return textResult(lines.join("\n"));
          }

          if (action === "create") {
            const content = asString(params.content);
            const streamName = asString(params.streamName);
            const userId = asNumber(params.userId);
            if (!content) {
              throw new Error("content is required for create");
            }
            if (streamName && userId) {
              throw new Error("provide only streamName or userId");
            }
            if (!streamName && !userId) {
              throw new Error("provide streamName or userId");
            }
            if (streamName) {
              const stream = await findStreamByName(client, streamName);
              const ids = await zulip.createZulipDraft(client, {
                type: "stream",
                to: [stream.stream_id],
                topic: asString(params.topic) ?? "(no topic)",
                content,
              });
              return textResult(`Created stream draft ${ids[0] ?? "(unknown)"}.`);
            }
            const ids = await zulip.createZulipDraft(client, {
              type: "private",
              to: [Math.trunc(userId as number)],
              topic: "",
              content,
            });
            return textResult(`Created DM draft ${ids[0] ?? "(unknown)"}.`);
          }

          if (action === "edit") {
            const draftId = asNumber(params.draftId);
            if (!draftId) {
              throw new Error("draftId is required for edit");
            }
            const existing = (await zulip.listZulipDrafts(client)).find((d) => d.id === Math.trunc(draftId));
            if (!existing) {
              throw new Error(`draft ${Math.trunc(draftId)} not found`);
            }
            let type = existing.type;
            let to = existing.to;
            let topic = existing.topic;
            const streamName = asString(params.streamName);
            const userId = asNumber(params.userId);
            if (streamName && userId) {
              throw new Error("provide only streamName or userId");
            }
            if (streamName) {
              const stream = await findStreamByName(client, streamName);
              type = "stream";
              to = [stream.stream_id];
              topic = asString(params.topic) ?? topic;
            }
            if (userId) {
              type = "private";
              to = [Math.trunc(userId)];
              topic = "";
            }
            const content = asString(params.content) ?? existing.content;
            await zulip.editZulipDraft(client, Math.trunc(draftId), {
              type,
              to,
              topic,
              content,
            });
            return textResult(`Draft ${Math.trunc(draftId)} updated.`);
          }

          if (action === "delete") {
            const draftId = asNumber(params.draftId);
            if (!draftId) {
              throw new Error("draftId is required for delete");
            }
            await zulip.deleteZulipDraft(client, Math.trunc(draftId));
            return textResult(`Draft ${Math.trunc(draftId)} deleted.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_topics",
      label: "Zulip Topics",
      description: "Resolve, unresolve, rename, move, or delete Zulip topics.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["resolve", "unresolve", "rename", "move", "delete"] },
          streamName: { type: "string" },
          topic: { type: "string" },
          newTopic: { type: "string" },
          targetStreamName: { type: "string" },
          propagateMode: { type: "string", enum: ["change_all", "change_later", "change_one"] },
        },
        required: ["action", "streamName", "topic"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);
          const streamName = asString(params.streamName);
          const topic = asString(params.topic);
          if (!streamName || !topic) {
            throw new Error("streamName and topic are required");
          }
          const stream = await findStreamByName(client, streamName);
          const propagateMode =
            (asString(params.propagateMode) as "change_all" | "change_later" | "change_one" | undefined) ??
            "change_all";

          const anchorResult = await zulip.getZulipMessagesAdvanced(client, {
            anchor: "newest",
            numBefore: 1,
            numAfter: 0,
            narrow: [
              { operator: "stream", operand: streamName },
              { operator: "topic", operand: topic },
            ],
          });
          const anchorMessageId = anchorResult.messages[0]?.id;

          if (action === "delete") {
            const result = await zulip.deleteZulipTopic(client, stream.stream_id, topic);
            return textResult(
              result.complete
                ? `Topic deleted: #${streamName} > ${topic}.`
                : "Topic deletion started; invoke again if more batches are needed.",
            );
          }

          if (!anchorMessageId) {
            throw new Error(`no anchor message found in #${streamName} > ${topic}`);
          }

          if (action === "resolve") {
            const resolvedTopic = topic.startsWith("[resolved] ") ? topic : `[resolved] ${topic}`;
            await zulip.updateZulipMessageContent(client, anchorMessageId, {
              topic: resolvedTopic,
              propagateMode,
            });
            return textResult(`Topic resolved: #${streamName} > ${resolvedTopic}.`);
          }

          if (action === "unresolve") {
            const unresolvedTopic = topic.replace(/^\[resolved\]\s+/, "");
            await zulip.updateZulipMessageContent(client, anchorMessageId, {
              topic: unresolvedTopic,
              propagateMode,
            });
            return textResult(`Topic unresolved: #${streamName} > ${unresolvedTopic}.`);
          }

          if (action === "rename") {
            const newTopic = asString(params.newTopic);
            if (!newTopic) {
              throw new Error("newTopic is required for rename");
            }
            await zulip.updateZulipMessageContent(client, anchorMessageId, {
              topic: newTopic,
              propagateMode,
            });
            return textResult(`Topic renamed to #${streamName} > ${newTopic}.`);
          }

          if (action === "move") {
            const newTopic = asString(params.newTopic) ?? topic;
            const targetStreamName = asString(params.targetStreamName);
            if (!targetStreamName || targetStreamName.toLowerCase() === streamName.toLowerCase()) {
              await zulip.updateZulipMessageContent(client, anchorMessageId, {
                topic: newTopic,
                propagateMode,
              });
              return textResult(`Topic moved within #${streamName} to ${newTopic}.`);
            }
            const targetStream = await findStreamByName(client, targetStreamName);
            const body = new URLSearchParams();
            body.set("stream_id", String(targetStream.stream_id));
            body.set("topic", newTopic);
            body.set("propagate_mode", propagateMode);
            await client.request(`/messages/${anchorMessageId}`, { method: "PATCH", body: body.toString() });
            return textResult(`Topic moved to #${targetStreamName} > ${newTopic}.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_linkifiers",
      label: "Zulip Linkifiers",
      description: "List and manage Zulip linkifiers.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "update", "remove", "reorder"] },
          filterId: { type: "number" },
          pattern: { type: "string" },
          urlTemplate: { type: "string" },
          orderedIds: { type: "array", items: { type: "number" } },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const linkifiers = await zulip.listZulipLinkifiers(client);
            const lines = linkifiers.map((l, idx) => `${idx + 1}. [${l.id}] ${l.pattern} -> ${l.url_template}`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No linkifiers configured.");
          }

          if (action === "add") {
            const pattern = asString(params.pattern);
            const urlTemplate = asString(params.urlTemplate);
            if (!pattern || !urlTemplate) {
              throw new Error("pattern and urlTemplate are required for add");
            }
            const added = await zulip.addZulipLinkifier(client, {
              pattern,
              url_template: urlTemplate,
            });
            return textResult(`Linkifier ${added.id} added.`);
          }

          if (action === "update") {
            const filterId = asNumber(params.filterId);
            const pattern = asString(params.pattern);
            const urlTemplate = asString(params.urlTemplate);
            if (!filterId) {
              throw new Error("filterId is required for update");
            }
            await zulip.updateZulipLinkifier(client, Math.trunc(filterId), {
              pattern,
              url_template: urlTemplate,
            });
            return textResult(`Linkifier ${Math.trunc(filterId)} updated.`);
          }

          if (action === "remove") {
            const filterId = asNumber(params.filterId);
            if (!filterId) {
              throw new Error("filterId is required for remove");
            }
            await zulip.removeZulipLinkifier(client, Math.trunc(filterId));
            return textResult(`Linkifier ${Math.trunc(filterId)} removed.`);
          }

          if (action === "reorder") {
            const orderedIds = (asNumberArray(params.orderedIds) ?? []).map((n) => Math.trunc(n));
            if (orderedIds.length === 0) {
              throw new Error("orderedIds is required for reorder");
            }
            await zulip.reorderZulipLinkifiers(client, orderedIds);
            return textResult(`Linkifiers reordered: ${orderedIds.join(", ")}.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_user_status",
      label: "Zulip User Status",
      description: "Get, set, or clear user status.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set", "clear"] },
          userId: { type: "number" },
          statusText: { type: "string" },
          emojiName: { type: "string" },
          emojiCode: { type: "string" },
          reactionType: { type: "string" },
          away: { type: "boolean" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "get") {
            const userId = asNumber(params.userId);
            if (!userId) {
              throw new Error("userId is required for get");
            }
            const status = await zulip.getZulipUserStatus(client, Math.trunc(userId));
            if (!status.status_text && !status.emoji_name) {
              return textResult(`User ${Math.trunc(userId)} has no status set.`);
            }
            return textResult(
              [
                status.emoji_name ? `Emoji: :${status.emoji_name}:` : null,
                status.status_text ? `Text: ${status.status_text}` : null,
              ]
                .filter((line): line is string => Boolean(line))
                .join("\n"),
            );
          }

          if (action === "set") {
            await zulip.updateZulipOwnStatus(client, {
              status_text: asString(params.statusText),
              emoji_name: asString(params.emojiName),
              emoji_code: asString(params.emojiCode),
              reaction_type: asString(params.reactionType),
              away: asBoolean(params.away),
            });
            return textResult("Status updated.");
          }

          if (action === "clear") {
            await zulip.updateZulipOwnStatus(client, {
              status_text: "",
              emoji_name: "",
              emoji_code: "",
              reaction_type: "",
            });
            return textResult("Status cleared.");
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_server_settings",
      label: "Zulip Server Settings",
      description: "Fetch server settings, custom profile fields, and user profile data.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["server_info", "profile_fields", "user_profile"] },
          userId: { type: "number" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "server_info") {
            const settings = await zulip.fetchZulipServerSettings(client);
            const lines = [
              `Version: ${String(settings.zulip_version ?? "unknown")}`,
              `Feature level: ${String(settings.zulip_feature_level ?? "unknown")}`,
              settings.realm_name ? `Organization: ${String(settings.realm_name)}` : null,
              settings.realm_uri ? `URL: ${String(settings.realm_uri)}` : null,
            ].filter((line): line is string => Boolean(line));
            return textResult(lines.join("\n"));
          }

          if (action === "profile_fields") {
            const fields = await zulip.listZulipCustomProfileFields(client);
            if (fields.length === 0) {
              return textResult("No custom profile fields configured.");
            }
            const lines = fields.map((field) => {
              const typeName = zulip.getProfileFieldTypeName(field.type);
              return `- ${field.name} (id:${field.id}, type:${typeName})`;
            });
            return textResult(lines.join("\n"));
          }

          if (action === "user_profile") {
            const userId = asNumber(params.userId);
            if (!userId) {
              throw new Error("userId is required for user_profile");
            }
            const [fields, profileData] = await Promise.all([
              zulip.listZulipCustomProfileFields(client),
              zulip.getZulipUserProfileData(client, Math.trunc(userId)),
            ]);
            const fieldMap = new Map(fields.map((field) => [String(field.id), field]));
            const entries = Object.entries(profileData);
            if (entries.length === 0) {
              return textResult(`User ${Math.trunc(userId)} has no profile data.`);
            }
            const lines = entries.map(([fieldId, data]) => {
              const field = fieldMap.get(fieldId);
              const label = field?.name ?? `Field ${fieldId}`;
              return `- ${label}: ${data.rendered_value ?? data.value}`;
            });
            return textResult(lines.join("\n"));
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_message_flags",
      label: "Zulip Message Flags",
      description: "Star/unstar, mark read/unread, mark topic read, and fetch read receipts.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["star", "unstar", "mark_read", "mark_unread", "mark_topic_read", "read_receipts"],
          },
          messageIds: { type: "array", items: { type: "number" } },
          messageId: { type: "number" },
          streamName: { type: "string" },
          topic: { type: "string" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "star" || action === "unstar" || action === "mark_read" || action === "mark_unread") {
            const messageIds = (asNumberArray(params.messageIds) ?? []).map((n) => Math.trunc(n));
            if (messageIds.length === 0) {
              throw new Error("messageIds is required");
            }
            const flag = action === "star" || action === "unstar" ? "starred" : "read";
            const op = action === "star" || action === "mark_read" ? "add" : "remove";
            const result = await zulip.updateZulipMessageFlags(client, {
              messages: messageIds,
              op,
              flag,
            });
            return textResult(`${action} affected ${result.messages.length} messages.`);
          }

          if (action === "mark_topic_read") {
            const streamName = asString(params.streamName);
            if (!streamName) {
              throw new Error("streamName is required for mark_topic_read");
            }
            const narrow: Array<Record<string, unknown>> = [{ operator: "stream", operand: streamName }];
            const topic = asString(params.topic);
            if (topic) {
              narrow.push({ operator: "topic", operand: topic });
            }

            let anchor: number | string = "oldest";
            let includeAnchor = true;
            let total = 0;
            for (;;) {
              const res = await zulip.updateZulipMessageFlagsForNarrow(client, {
                narrow,
                op: "add",
                flag: "read",
                anchor,
                includeAnchor,
                numBefore: 0,
                numAfter: 5000,
              });
              total += res.messages.length;
              if (res.found_newest || res.messages.length === 0) {
                break;
              }
              anchor = Math.max(...res.messages);
              includeAnchor = false;
            }
            return textResult(`Marked ${total} messages as read in #${streamName}${topic ? ` > ${topic}` : ""}.`);
          }

          if (action === "read_receipts") {
            const messageId = asNumber(params.messageId);
            if (!messageId) {
              throw new Error("messageId is required for read_receipts");
            }
            const userIds = await zulip.getZulipReadReceipts(client, Math.trunc(messageId));
            return textResult(
              userIds.length > 0
                ? `Read by ${userIds.length} user(s): ${userIds.join(", ")}`
                : "No read receipts available.",
            );
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_upload",
      label: "Zulip Upload",
      description: "Upload files to Zulip from URL or base64 and return markdown link info.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          base64: { type: "string" },
          fileName: { type: "string" },
          contentType: { type: "string" },
        },
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        let tempPath: string | undefined;
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const url = asString(params.url);
          const base64 = asString(params.base64);
          let fileName = asString(params.fileName)?.trim();
          let contentType = asString(params.contentType)?.trim();
          if ((!url && !base64) || (url && base64)) {
            throw new Error("provide exactly one of url or base64");
          }

          let fileBuffer: Buffer;
          if (base64) {
            let raw = base64;
            if (raw.startsWith("data:")) {
              const commaIndex = raw.indexOf(",");
              if (commaIndex > -1) {
                const meta = raw.slice(5, commaIndex);
                const mime = meta.split(";")[0];
                if (mime && !contentType) {
                  contentType = mime;
                }
                raw = raw.slice(commaIndex + 1);
              }
            }
            const stripped = raw.replace(/\s/g, "");
            fileBuffer = Buffer.from(stripped, "base64");
            if (fileBuffer.length === 0) {
              throw new Error("decoded base64 is empty");
            }
            if (!fileName) {
              fileName = "upload";
            }
          } else {
            const fetchResponse = await fetch(url as string);
            if (!fetchResponse.ok) {
              throw new Error(`failed to fetch URL (${fetchResponse.status})`);
            }
            if (!contentType) {
              contentType = fetchResponse.headers.get("content-type")?.split(";")[0].trim();
            }
            fileBuffer = Buffer.from(await fetchResponse.arrayBuffer());
            if (!fileName) {
              try {
                fileName = basename(new URL(url as string).pathname) || "upload";
              } catch {
                fileName = "upload";
              }
            }
          }

          const extMap: Record<string, string> = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "application/pdf": ".pdf",
            "text/plain": ".txt",
          };
          if (fileName && !fileName.includes(".") && contentType && extMap[contentType]) {
            fileName = `${fileName}${extMap[contentType]}`;
          }

          const safeName = (fileName ?? "upload").replace(/[\\/]/g, "_");
          tempPath = join(tmpdir(), `zulip-upload-${randomUUID()}-${safeName}`);
          await writeFile(tempPath, fileBuffer);
          const uploaded = await zulip.uploadZulipFileViaClient(client, tempPath);
          const sizeBytes = fileBuffer.length;
          const markdown = `[${safeName}](${uploaded.url})`;
          return textResult(
            [
              `Name: ${safeName}`,
              `Size: ${sizeBytes} bytes`,
              `URI: ${uploaded.url}`,
              `Markdown: ${markdown}`,
            ].join("\n"),
          );
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        } finally {
          if (tempPath) {
            await unlink(tempPath).catch(() => undefined);
          }
        }
      },
    });

    api.registerTool({
      name: "zulip_alert_words",
      label: "Zulip Alert Words",
      description: "List, add, and remove alert words.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove"] },
          words: { type: "array", items: { type: "string" } },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const words = await zulip.listZulipAlertWords(client);
            return textResult(words.length > 0 ? words.map((w) => `- ${w}`).join("\n") : "No alert words configured.");
          }

          if (action === "add" || action === "remove") {
            const words = (asStringArray(params.words) ?? []).map((w) => w.trim()).filter(Boolean);
            if (words.length === 0) {
              throw new Error("non-empty words array is required");
            }
            const updated =
              action === "add"
                ? await zulip.addZulipAlertWords(client, words)
                : await zulip.removeZulipAlertWords(client, words);
            return textResult(`${action} complete. total words: ${updated.length}.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_user_preferences",
      label: "Zulip User Preferences",
      description: "Manage topic visibility and muted users.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "mute_topic",
              "unmute_topic",
              "follow_topic",
              "reset_topic",
              "list_muted_users",
              "mute_user",
              "unmute_user",
            ],
          },
          streamName: { type: "string" },
          topic: { type: "string" },
          userId: { type: "number" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list_muted_users") {
            const mutedUsers = await zulip.listZulipMutedUsers(client);
            const lines = mutedUsers.map((entry) => `- ${entry.id} (muted_at:${new Date(entry.timestamp * 1000).toISOString()})`);
            return textResult(lines.length > 0 ? lines.join("\n") : "No muted users.");
          }

          if (action === "mute_user" || action === "unmute_user") {
            const userId = asNumber(params.userId);
            if (!userId) {
              throw new Error("userId is required");
            }
            if (action === "mute_user") {
              await zulip.muteZulipUser(client, Math.trunc(userId));
            } else {
              await zulip.unmuteZulipUser(client, Math.trunc(userId));
            }
            return textResult(`${action} complete for user ${Math.trunc(userId)}.`);
          }

          if (action === "mute_topic" || action === "unmute_topic" || action === "follow_topic" || action === "reset_topic") {
            const streamName = asString(params.streamName);
            const topic = asString(params.topic);
            if (!streamName || !topic) {
              throw new Error("streamName and topic are required");
            }
            const stream = await findStreamByName(client, streamName);
            const policyMap: Record<string, zulip.ZulipTopicVisibilityPolicy> = {
              mute_topic: zulip.TOPIC_VISIBILITY_POLICIES.muted,
              unmute_topic: zulip.TOPIC_VISIBILITY_POLICIES.unmuted,
              follow_topic: zulip.TOPIC_VISIBILITY_POLICIES.followed,
              reset_topic: zulip.TOPIC_VISIBILITY_POLICIES.none,
            };
            const policy = policyMap[action];
            await zulip.updateZulipUserTopic(client, {
              streamId: stream.stream_id,
              topic,
              visibilityPolicy: policy,
            });
            return textResult(
              `${action} complete for #${streamName} > ${topic} (policy:${zulip.TOPIC_VISIBILITY_LABELS[policy]}).`,
            );
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_stream_settings",
      label: "Zulip Stream Settings",
      description: "Get and update per-stream subscription settings.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get", "pin", "unpin", "mute", "unmute", "set_color", "set_notifications"],
          },
          streamName: { type: "string" },
          color: { type: "string" },
          desktopNotifications: { type: ["boolean", "null"] },
          pushNotifications: { type: ["boolean", "null"] },
          emailNotifications: { type: ["boolean", "null"] },
          audibleNotifications: { type: ["boolean", "null"] },
          wildcardMentionsNotify: { type: ["boolean", "null"] },
        },
        required: ["action", "streamName"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);
          const streamName = asString(params.streamName);
          if (!streamName) {
            throw new Error("streamName is required");
          }
          const sub = (await zulip.fetchZulipSubscriptions(client)).find(
            (subscription) => subscription.name?.toLowerCase() === streamName.toLowerCase(),
          );
          if (!sub?.stream_id) {
            throw new Error(`stream not found in subscriptions: ${streamName}`);
          }
          const streamId = sub.stream_id;
          const subRec = sub as Record<string, unknown>;

          if (action === "get") {
            const formatSetting = (value: unknown): string => {
              if (value === true) {
                return "On";
              }
              if (value === false) {
                return "Off";
              }
              return "Default";
            };
            return textResult(
              [
                `Stream: ${sub.name ?? streamName} (id:${streamId})`,
                `Pinned: ${subRec.pin_to_top === true ? "Yes" : "No"}`,
                `Muted: ${subRec.is_muted === true ? "Yes" : "No"}`,
                `Color: ${String(subRec.color ?? "(default)")}`,
                `Desktop notifications: ${formatSetting(subRec.desktop_notifications)}`,
                `Push notifications: ${formatSetting(subRec.push_notifications)}`,
                `Email notifications: ${formatSetting(subRec.email_notifications)}`,
                `Audible notifications: ${formatSetting(subRec.audible_notifications)}`,
                `Wildcard mentions notify: ${formatSetting(subRec.wildcard_mentions_notify)}`,
              ].join("\n"),
            );
          }

          if (action === "pin" || action === "unpin" || action === "mute" || action === "unmute") {
            const property = action === "pin" || action === "unpin" ? "pin_to_top" : "is_muted";
            const value = action === "pin" || action === "mute";
            await zulip.updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property, value },
            ]);
            return textResult(`${action} complete for #${streamName}.`);
          }

          if (action === "set_color") {
            const color = asString(params.color);
            if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
              throw new Error("color must be a 6-digit hex value like #aabbcc");
            }
            await zulip.updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property: "color", value: color },
            ]);
            return textResult(`Set #${streamName} color to ${color}.`);
          }

          if (action === "set_notifications") {
            const properties: zulip.ZulipSubscriptionProperty[] = [];
            if ("desktopNotifications" in params) {
              properties.push({
                stream_id: streamId,
                property: "desktop_notifications",
                value: params.desktopNotifications ?? null,
              });
            }
            if ("pushNotifications" in params) {
              properties.push({
                stream_id: streamId,
                property: "push_notifications",
                value: params.pushNotifications ?? null,
              });
            }
            if ("emailNotifications" in params) {
              properties.push({
                stream_id: streamId,
                property: "email_notifications",
                value: params.emailNotifications ?? null,
              });
            }
            if ("audibleNotifications" in params) {
              properties.push({
                stream_id: streamId,
                property: "audible_notifications",
                value: params.audibleNotifications ?? null,
              });
            }
            if ("wildcardMentionsNotify" in params) {
              properties.push({
                stream_id: streamId,
                property: "wildcard_mentions_notify",
                value: params.wildcardMentionsNotify ?? null,
              });
            }
            if (properties.length === 0) {
              throw new Error("at least one notification setting is required");
            }
            await zulip.updateZulipSubscriptionProperties(client, properties);
            return textResult(`Updated ${properties.length} notification setting(s) for #${streamName}.`);
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "zulip_attachments",
      label: "Zulip Attachments",
      description: "List, delete, and inspect attachment storage usage.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "delete", "usage"] },
          attachmentId: { type: "number" },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const cfg = api.runtime.config.loadConfig();
          const client = getClient(cfg);
          const action = getAction(params);

          if (action === "list") {
            const { attachments } = await zulip.listZulipAttachments(client);
            if (attachments.length === 0) {
              return textResult("No attachments found.");
            }
            const lines = attachments.map((attachment) => {
              const when = new Date(attachment.create_time * 1000).toISOString();
              return `- [${attachment.id}] ${attachment.name} (${attachment.size} bytes, ${when})`;
            });
            return textResult(lines.join("\n"));
          }

          if (action === "delete") {
            const attachmentId = asNumber(params.attachmentId);
            if (!attachmentId) {
              throw new Error("attachmentId is required for delete");
            }
            await zulip.deleteZulipAttachment(client, Math.trunc(attachmentId));
            return textResult(`Attachment ${Math.trunc(attachmentId)} deleted.`);
          }

          if (action === "usage") {
            const { uploadSpaceUsed, attachments } = await zulip.listZulipAttachments(client);
            const totalCount = attachments.length;
            const avg = totalCount > 0 ? Math.round(uploadSpaceUsed / totalCount) : 0;
            return textResult(
              [
                `Upload space used: ${uploadSpaceUsed} bytes`,
                `Attachments: ${totalCount}`,
                `Average size: ${avg} bytes`,
              ].join("\n"),
            );
          }

          throw new Error(`Unknown action: ${action}`);
        } catch (err) {
          return textResult(`Error: ${(err as Error).message}`);
        }
      },
    });
  },
};

export default plugin;
