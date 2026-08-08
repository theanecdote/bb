import { z } from "zod";
import { pendingCreateKey } from "./contract";

/**
 * How long one explicit Send invocation stays deduplicated. The record is
 * kept for the whole window whether the attempt failed or succeeded: the
 * failure mode idempotency exists for is a lost response after the companion
 * already created the thread, and that only replays correctly if the
 * completed record survives.
 */
export const PENDING_CREATE_TTL_MS = 9 * 60 * 1000;

export type PendingStorage = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
};

const PendingCreateSchema = z.object({
  requestId: z.string(),
  createdAt: z.number().int().nonnegative(),
  /** Present once the companion confirmed the thread for this invocation. */
  completedAmpThreadId: z.string().optional(),
});

export type PendingCreate = z.infer<typeof PendingCreateSchema>;

function isFresh(record: PendingCreate, now: number) {
  return now - record.createdAt < PENDING_CREATE_TTL_MS;
}

/**
 * Resolve the create request for one Send invocation: a fresh record is
 * reused (so a retry replays the same request, or short-circuits entirely
 * when the earlier attempt already completed), and anything missing or
 * expired starts a new one.
 */
export async function claimPendingCreate(
  kv: PendingStorage,
  threadId: string,
  invocationId: string | undefined,
  requestId: string,
  now: number,
): Promise<PendingCreate> {
  const key = pendingCreateKey(threadId, invocationId);
  const stored = PendingCreateSchema.safeParse(await kv.get(key));
  if (stored.success && isFresh(stored.data, now)) return stored.data;
  const record: PendingCreate = { requestId, createdAt: now };
  await kv.set(key, record);
  return record;
}

/** Mark the invocation complete, keeping it deduplicated for the full TTL. */
export async function completePendingCreate(
  kv: PendingStorage,
  threadId: string,
  invocationId: string | undefined,
  record: PendingCreate,
  ampThreadId: string,
) {
  await kv.set(pendingCreateKey(threadId, invocationId), {
    ...record,
    completedAmpThreadId: ampThreadId,
  });
}

/**
 * Drop expired records for this BB thread. Retaining completed records means
 * they no longer delete themselves, so each send sweeps its own thread's
 * leftovers instead of letting KV grow without bound.
 */
export async function prunePendingCreates(
  kv: PendingStorage,
  threadId: string,
  now: number,
) {
  const threadKey = pendingCreateKey(threadId);
  // A bare prefix scan would also match `thr_10` while sweeping `thr_1`.
  const keys = (await kv.list(threadKey)).filter(
    (key) => key === threadKey || key.startsWith(`${threadKey}:`),
  );
  for (const key of keys) {
    const stored = PendingCreateSchema.safeParse(await kv.get(key));
    if (!stored.success || !isFresh(stored.data, now)) await kv.delete(key);
  }
}
