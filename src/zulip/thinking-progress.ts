import type { ZulipAuth } from "./client.js";
import { editZulipStreamMessage, sendZulipStreamMessage } from "./send.js";
import { formatClockTime } from "./tool-progress.js";

export type ThinkingAccumulatorParams = {
  auth: ZulipAuth;
  stream: string;
  topic: string;
  debounceMs: number;
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
};

export class ThinkingAccumulator {
  private buffer = "";
  private messageId: number | undefined;
  private editTimer: NodeJS.Timeout | undefined;
  private flushInFlight: Promise<void> | undefined;
  private finalized = false;
  private startedAt = 0;
  private readonly params: ThinkingAccumulatorParams;

  constructor(params: ThinkingAccumulatorParams) {
    this.params = params;
  }

  get hasContent(): boolean {
    return this.buffer.length > 0;
  }

  get hasSentMessage(): boolean {
    return this.messageId !== undefined;
  }

  append(text: string): void {
    if (this.finalized) return;
    if (!this.buffer) {
      this.startedAt = Date.now();
    }
    this.buffer += text;
    this.scheduleFlush();
  }

  private renderMessage(complete: boolean): string {
    const sanitized = ThinkingAccumulator.sanitizeForCodeFence(this.buffer);
    if (complete) {
      const tokens = ThinkingAccumulator.estimateTokens(this.buffer);
      const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      const header = `\u{1F9E0} **Thinking complete** \u00B7 ~${tokens} tokens \u00B7 ${elapsed}s`;
      return `${header}\n\n\`\`\`spoiler Thinking\n${sanitized}\n\`\`\``;
    }
    const updated = formatClockTime(Date.now());
    const header = `\u{1F9E0} **Thinking...** \u00B7 updated ${updated}`;
    return `${header}\n\n\`\`\`spoiler Thinking\n${sanitized}\n\`\`\``;
  }

  static estimateTokens(text: string): string {
    const count = Math.round(text.length / 4);
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return String(count);
  }

  static sanitizeForCodeFence(text: string): string {
    return text.replace(/`{3,}/g, (match) => match.split("").join("\u200B"));
  }

  private scheduleFlush(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      void this.flush();
    }, this.params.debounceMs);
    this.editTimer.unref?.();
  }

  private cancelScheduledFlush(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  async flush(): Promise<void> {
    if (!this.buffer) return;
    const previousFlush = this.flushInFlight;
    const current = (async () => {
      if (previousFlush) {
        await previousFlush.catch(() => undefined);
      }
      const content = this.renderMessage(this.finalized);
      try {
        if (this.messageId) {
          await editZulipStreamMessage({
            auth: this.params.auth,
            messageId: this.messageId,
            content,
            abortSignal: this.params.abortSignal,
          });
        } else {
          const response = await sendZulipStreamMessage({
            auth: this.params.auth,
            stream: this.params.stream,
            topic: this.params.topic,
            content,
            abortSignal: this.params.abortSignal,
          });
          if (response?.id && typeof response.id === "number") {
            this.messageId = response.id;
          }
        }
      } catch (err) {
        this.params.log?.(
          `[zulip] thinking flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    this.flushInFlight = current;
    await current;
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelScheduledFlush();
    if (this.buffer) {
      await this.flush();
    }
  }

  dispose(): void {
    this.finalized = true;
    this.cancelScheduledFlush();
  }
}
