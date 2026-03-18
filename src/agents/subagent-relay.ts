export type MainMessageRelayKey = {
  provider: string;
  accountId: string;
  messageId: string;
};

export type MainMessageRunRelayEntry = MainMessageRelayKey & {
  runId: string;
  status?: string;
  model?: string;
  updatedAtMs: number;
};

export type MainMessageRunRelayPatch = {
  status?: string;
  model?: string;
  updatedAtMs?: number;
};

const relayByMessageKey = new Map<string, MainMessageRunRelayEntry>();
const messageKeyByRunId = new Map<string, string>();

function buildRelayMessageKey(key: MainMessageRelayKey): string {
  return `${key.provider}:${key.accountId}:${key.messageId}`;
}

function copyRelayEntry(entry: MainMessageRunRelayEntry): MainMessageRunRelayEntry {
  return { ...entry };
}

export function registerMainMessageRunRelay(
  params: MainMessageRelayKey & {
    runId: string;
    status?: string;
    model?: string;
    now?: () => number;
  },
): MainMessageRunRelayEntry {
  const now = params.now ?? (() => Date.now());
  const messageKey = buildRelayMessageKey(params);

  const entry: MainMessageRunRelayEntry = {
    provider: params.provider,
    accountId: params.accountId,
    messageId: params.messageId,
    runId: params.runId,
    status: params.status,
    model: params.model,
    updatedAtMs: now(),
  };

  const previous = relayByMessageKey.get(messageKey);
  if (previous && previous.runId !== entry.runId) {
    messageKeyByRunId.delete(previous.runId);
  }

  relayByMessageKey.set(messageKey, entry);
  messageKeyByRunId.set(entry.runId, messageKey);
  return copyRelayEntry(entry);
}

export function updateMainMessageRunRelay(
  runId: string,
  patch: MainMessageRunRelayPatch,
): MainMessageRunRelayEntry | undefined {
  const messageKey = messageKeyByRunId.get(runId);
  if (!messageKey) {
    return undefined;
  }
  const existing = relayByMessageKey.get(messageKey);
  if (!existing || existing.runId !== runId) {
    return undefined;
  }

  const next: MainMessageRunRelayEntry = {
    ...existing,
    ...patch,
    updatedAtMs: patch.updatedAtMs ?? Date.now(),
  };
  relayByMessageKey.set(messageKey, next);
  return copyRelayEntry(next);
}

export function lookupMainMessageRunRelay(key: MainMessageRelayKey): MainMessageRunRelayEntry | undefined {
  const entry = relayByMessageKey.get(buildRelayMessageKey(key));
  return entry ? copyRelayEntry(entry) : undefined;
}

export function clearMainMessageRunRelay(key: MainMessageRelayKey): void {
  const messageKey = buildRelayMessageKey(key);
  const existing = relayByMessageKey.get(messageKey);
  if (!existing) {
    return;
  }
  relayByMessageKey.delete(messageKey);
  messageKeyByRunId.delete(existing.runId);
}
