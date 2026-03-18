import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getZulipRuntime: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getZulipRuntime: mocks.getZulipRuntime,
}));

import { downloadZulipUploads, extractZulipUploadUrls } from "./uploads.js";

const baseAuth = {
  baseUrl: "https://zulip.example.com",
  email: "bot@zulip.example.com",
  apiKey: "secret",
};

const baseCfg = {
  channels: {
    zulip: {},
  },
} as const;

describe("zulip uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts relative /user_uploads links", () => {
    const urls = extractZulipUploadUrls(
      "see this: [file](/user_uploads/abc123/photo.png)",
      "https://zulip.example.com",
    );
    expect(urls).toEqual(["https://zulip.example.com/user_uploads/abc123/photo.png"]);
  });

  it("extracts absolute URLs and trims markdown delimiters", () => {
    const urls = extractZulipUploadUrls(
      "img: https://zulip.example.com/user_uploads/xyz/cat.jpg).",
      "https://zulip.example.com/",
    );
    expect(urls).toEqual(["https://zulip.example.com/user_uploads/xyz/cat.jpg"]);
  });

  it("dedupes and rejects uploads on other origins", () => {
    const urls = extractZulipUploadUrls(
      [
        "one: /user_uploads/a.png",
        "two: https://zulip.example.com/user_uploads/a.png",
        "bad: https://evil.example.com/user_uploads/pwn.png",
      ].join("\n"),
      "https://zulip.example.com",
    );
    expect(urls).toEqual(["https://zulip.example.com/user_uploads/a.png"]);
  });

  it("converts inbound HEIC uploads to JPEG before saving", async () => {
    const heicBuffer = Buffer.from("heic-data");
    const jpegBuffer = Buffer.from("jpeg-data");
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: heicBuffer,
      contentType: "image/heic",
      fileName: "photo.heic",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/inbound/photo.jpg",
      contentType: "image/jpeg",
    }));
    const heicConverter = vi.fn(async () => jpegBuffer);

    mocks.getZulipRuntime.mockReturnValue({
      channel: {
        media: {
          fetchRemoteMedia,
          saveMediaBuffer,
        },
      },
    });

    const uploads = await downloadZulipUploads({
      cfg: baseCfg,
      accountId: "default",
      auth: baseAuth,
      content: "see /user_uploads/1/photo.heic",
      heicConverter,
    });

    expect(heicConverter).toHaveBeenCalledWith(heicBuffer);
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      jpegBuffer,
      "image/jpeg",
      "inbound",
      5 * 1024 * 1024,
      "photo.jpg",
    );
    expect(uploads).toEqual([
      {
        url: "https://zulip.example.com/user_uploads/1/photo.heic",
        path: "/tmp/inbound/photo.jpg",
        contentType: "image/jpeg",
        placeholder: "[Zulip upload: photo.jpg]",
      },
    ]);
  });

  it("keeps inbound HEIC uploads unchanged when conversion is unavailable", async () => {
    const heicBuffer = Buffer.from("heic-data");
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: heicBuffer,
      contentType: "image/heif",
      fileName: "photo.heif",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/inbound/photo.heif",
      contentType: "image/heif",
    }));
    const heicConverter = vi.fn(async () => {
      throw new Error("converter unavailable");
    });

    mocks.getZulipRuntime.mockReturnValue({
      channel: {
        media: {
          fetchRemoteMedia,
          saveMediaBuffer,
        },
      },
    });

    const uploads = await downloadZulipUploads({
      cfg: baseCfg,
      accountId: "default",
      auth: baseAuth,
      content: "see /user_uploads/1/photo.heif",
      heicConverter,
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      heicBuffer,
      "image/heif",
      "inbound",
      5 * 1024 * 1024,
      "photo.heif",
    );
    expect(uploads[0]?.placeholder).toBe("[Zulip upload: photo.heif]");
  });

  describe("media sweep", () => {
    let tempDir = "";

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-upload-sweep-"));
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it("removes expired media entries from the download temp directory", async () => {
      const stalePath = path.join(tempDir, "stale.bin");
      await fs.writeFile(stalePath, "stale", "utf8");

      const freshPath = path.join(tempDir, "fresh.jpg");
      const saveMediaBuffer = vi.fn(async (buffer: Buffer) => {
        await fs.writeFile(freshPath, buffer);
        return {
          path: freshPath,
          contentType: "image/jpeg",
        };
      });

      const nowMs = Date.now();
      const staleTime = new Date(nowMs - 10_000);
      await fs.utimes(stalePath, staleTime, staleTime);

      mocks.getZulipRuntime.mockReturnValue({
        channel: {
          media: {
            fetchRemoteMedia: vi.fn(async () => ({
              buffer: Buffer.from("new"),
              contentType: "image/jpeg",
              fileName: "fresh.jpg",
            })),
            saveMediaBuffer,
          },
        },
      });

      await downloadZulipUploads({
        cfg: baseCfg,
        accountId: "default",
        auth: baseAuth,
        content: "see /user_uploads/1/fresh.jpg",
        mediaSweepTtlMs: 1_000,
        mediaSweepNowMs: nowMs,
      });

      await expect(fs.stat(freshPath)).resolves.toBeTruthy();
      await expect(fs.stat(stalePath)).rejects.toThrow();
    });
  });
});
