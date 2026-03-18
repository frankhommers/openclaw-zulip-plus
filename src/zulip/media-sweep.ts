import fs from "node:fs/promises";
import path from "node:path";

export type MediaSweepResult = {
  scanned: number;
  deleted: number;
};

export async function sweepExpiredMedia(params: {
  directory: string;
  ttlMs: number;
  nowMs?: number;
}): Promise<MediaSweepResult> {
  const ttlMs = Math.max(0, Math.floor(params.ttlMs));
  if (ttlMs <= 0) {
    return { scanned: 0, deleted: 0 };
  }

  const nowMs = params.nowMs ?? Date.now();
  const cutoff = nowMs - ttlMs;

  const entries = await fs.readdir(params.directory, { withFileTypes: true }).catch((error) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  });

  let scanned = 0;
  let deleted = 0;

  for (const entry of entries) {
    const entryPath = path.join(params.directory, entry.name);
    const stats = await fs.stat(entryPath).catch(() => null);
    if (!stats) {
      continue;
    }
    scanned += 1;
    if (stats.mtimeMs > cutoff) {
      continue;
    }
    try {
      if (stats.isDirectory()) {
        await fs.rmdir(entryPath);
      } else {
        await fs.unlink(entryPath);
      }
      deleted += 1;
    } catch {
      continue;
    }
  }

  return { scanned, deleted };
}
