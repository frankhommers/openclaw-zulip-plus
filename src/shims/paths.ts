import os from "node:os";
import path from "node:path";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}
