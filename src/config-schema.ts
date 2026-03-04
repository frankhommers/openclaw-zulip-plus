import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const ReactionWorkflowStagesSchema = z
  .object({
    queued: z.string().optional(),
    processing: z.string().optional(),
    toolRunning: z.string().optional(),
    retrying: z.string().optional(),
    success: z.string().optional(),
    partialSuccess: z.string().optional(),
    failure: z.string().optional(),
  })
  .passthrough();

const ReactionWorkflowSchema = z
  .object({
    enabled: z.boolean().optional(),
    replaceStageReaction: z.boolean().optional(),
    minTransitionMs: z.number().int().nonnegative().optional(),
    stages: ReactionWorkflowStagesSchema.optional(),
  })
  .passthrough();

const GenericReactionCallbackSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeRemoveOps: z.boolean().optional(),
  })
  .passthrough();

const ReactionSchema = z
  .object({
    enabled: z.boolean().optional(),
    onStart: z.string().optional(),
    onSuccess: z.string().optional(),
    onFailure: z.string().optional(),
    onError: z.string().optional(),
    clearOnFinish: z.boolean().optional(),
    workflow: ReactionWorkflowSchema.optional(),
    genericCallback: GenericReactionCallbackSchema.optional(),
  })
  .passthrough();

const ProcessingSpinnerSchema = z
  .object({
    enabled: z.boolean().optional(),
    emoji: z.array(z.string()).optional(),
    intervalMs: z.number().int().positive().optional(),
  })
  .passthrough();

const WorkingMessagesSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();

const ZulipAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    enableAdminActions: z.boolean().optional(),
    baseUrl: z.string().optional(),
    url: z.string().optional(),
    site: z.string().optional(),
    realm: z.string().optional(),
    email: z.string().optional(),
    apiKey: z.string().optional(),
    streams: z.array(z.string()).optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional(),
    alwaysReply: z.boolean().optional(),
    defaultTopic: z.string().optional(),
    reactions: ReactionSchema.optional(),
    processingSpinner: ProcessingSpinnerSchema.optional(),
    workingMessages: WorkingMessagesSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    requireMention: z.boolean().optional(),
  })
  .passthrough();

export const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
  accounts: z.record(z.string(), ZulipAccountSchemaBase.optional()).optional(),
}).passthrough();
