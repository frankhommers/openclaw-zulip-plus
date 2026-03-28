import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/infra-runtime";
import { readZulipError } from "./client.js";
import { normalizeZulipBaseUrl } from "./normalize.js";

export type ZulipProbeResult = {
  ok: boolean;
  baseUrl?: string;
  bot?: {
    userId: number;
    email: string | null;
    fullName: string | null;
  };
  error?: string;
};

/**
 * Validate Zulip credentials by calling `/api/v1/users/me`.
 * Returns bot identity on success, or a diagnostic error message.
 */
export async function probeZulip(
  baseUrl: string,
  email: string,
  apiKey: string,
  timeoutMs?: number,
): Promise<ZulipProbeResult> {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "invalid baseUrl" };
  }
  const controller = new AbortController();
  const timeout = timeoutMs ? setTimeout(() => controller.abort(), Math.max(timeoutMs, 500)) : null;

  try {
    const authHeader = Buffer.from(`${email}:${apiKey}`).toString("base64");
    const { response: res, release } = await fetchWithSsrFGuard({
      url: `${normalized}/api/v1/users/me`,
      init: {
        headers: {
          Authorization: `Basic ${authHeader}`,
        },
        signal: controller.signal,
      },
    });
    try {
      if (!res.ok) {
        const detail = await readZulipError(res);
        return { ok: false, error: detail || res.statusText };
      }
      const data = (await res.json()) as {
        result?: string;
        msg?: string;
        user_id?: number;
        email?: string;
        full_name?: string;
      };
      if (data.result && data.result !== "success") {
        return { ok: false, error: data.msg || "Zulip API error" };
      }
      return {
        ok: true,
        baseUrl: normalized,
        bot: {
          userId: data.user_id ?? 0,
          email: data.email ?? null,
          fullName: data.full_name ?? null,
        },
      };
    } finally {
      await release();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
