import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PENDING_CREATE_TTL_MS,
  claimPendingCreate,
  completePendingCreate,
  prunePendingCreates,
  type PendingStorage,
} from "../pending";

function fakeKv(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed));
  const kv: PendingStorage & { rows: Map<string, unknown> } = {
    rows,
    async get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      rows.set(key, value);
    },
    async delete(key: string) {
      rows.delete(key);
    },
    async list(prefix = "") {
      return [...rows.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  return kv;
}

const NOW = 1_800_000_000_000;

describe("send invocation idempotency records", () => {
  it("reuses one request id for retries of the same invocation", async () => {
    const kv = fakeKv();
    const first = await claimPendingCreate(kv, "thr_1", "inv-a", "req-1", NOW);
    const retry = await claimPendingCreate(kv, "thr_1", "inv-a", "req-2", NOW + 5_000);
    assert.equal(first.requestId, "req-1");
    assert.equal(retry.requestId, "req-1");
  });

  it("gives a different invocation its own request id", async () => {
    const kv = fakeKv();
    await claimPendingCreate(kv, "thr_1", "inv-a", "req-1", NOW);
    const other = await claimPendingCreate(kv, "thr_1", "inv-b", "req-2", NOW);
    assert.equal(other.requestId, "req-2");
  });

  it("keeps a completed invocation deduplicated for the whole window", async () => {
    const kv = fakeKv();
    const record = await claimPendingCreate(kv, "thr_1", "inv-a", "req-1", NOW);
    await completePendingCreate(kv, "thr_1", "inv-a", record, "T-1");

    const replay = await claimPendingCreate(
      kv,
      "thr_1",
      "inv-a",
      "req-2",
      NOW + PENDING_CREATE_TTL_MS - 1,
    );
    assert.equal(replay.completedAmpThreadId, "T-1");
    assert.equal(replay.requestId, "req-1");
  });

  it("starts a new record once the window has passed", async () => {
    const kv = fakeKv();
    const record = await claimPendingCreate(kv, "thr_1", "inv-a", "req-1", NOW);
    await completePendingCreate(kv, "thr_1", "inv-a", record, "T-1");

    const expired = await claimPendingCreate(
      kv,
      "thr_1",
      "inv-a",
      "req-2",
      NOW + PENDING_CREATE_TTL_MS,
    );
    assert.equal(expired.requestId, "req-2");
    assert.equal(expired.completedAmpThreadId, undefined);
  });

  it("falls back to the legacy key when no invocation id is given", async () => {
    const kv = fakeKv();
    await claimPendingCreate(kv, "thr_1", undefined, "req-1", NOW);
    assert.equal(kv.rows.has("pending-create:thr_1"), true);
  });

  it("prunes only this thread's expired records", async () => {
    const kv = fakeKv();
    await claimPendingCreate(kv, "thr_1", "old", "req-old", NOW);
    await claimPendingCreate(kv, "thr_1", "new", "req-new", NOW + 60_000);
    await claimPendingCreate(kv, "thr_10", "other", "req-other", NOW);
    kv.rows.set("pending-create:thr_1:junk", { nope: true });

    await prunePendingCreates(kv, "thr_1", NOW + PENDING_CREATE_TTL_MS + 1_000);

    assert.deepEqual([...kv.rows.keys()].sort(), [
      "pending-create:thr_10:other",
      "pending-create:thr_1:new",
    ]);
  });
});
