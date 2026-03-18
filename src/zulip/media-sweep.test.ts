import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepExpiredMedia } from "./media-sweep.js";

describe("sweepExpiredMedia", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
    tempDirs.length = 0;
  });

  it("deletes expired files and keeps fresh entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-media-sweep-"));
    tempDirs.push(dir);

    const stale = path.join(dir, "old.jpg");
    const fresh = path.join(dir, "new.jpg");
    await fs.writeFile(stale, "old", "utf8");
    await fs.writeFile(fresh, "new", "utf8");

    const nowMs = Date.now();
    const staleTime = new Date(nowMs - 10_000);
    const freshTime = new Date(nowMs - 100);
    await fs.utimes(stale, staleTime, staleTime);
    await fs.utimes(fresh, freshTime, freshTime);

    const result = await sweepExpiredMedia({
      directory: dir,
      ttlMs: 1_000,
      nowMs,
    });

    expect(result.deleted).toBe(1);
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
  });

  it("does not delete stale directories recursively", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-media-sweep-"));
    tempDirs.push(dir);

    const staleDir = path.join(dir, "nested");
    const nestedFresh = path.join(staleDir, "fresh.jpg");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(nestedFresh, "new", "utf8");

    const nowMs = Date.now();
    const staleTime = new Date(nowMs - 10_000);
    await fs.utimes(staleDir, staleTime, staleTime);

    const result = await sweepExpiredMedia({
      directory: dir,
      ttlMs: 1_000,
      nowMs,
    });

    expect(result.deleted).toBe(0);
    await expect(fs.stat(nestedFresh)).resolves.toBeTruthy();
  });
});
