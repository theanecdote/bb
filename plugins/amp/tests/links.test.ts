import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AmpLink } from "../contract";
import {
  legacyLinkKey,
  linkListKey,
  readLinkRecord,
  readLinks,
  saveLink,
  type LinkStorage,
} from "../links";

function fakeKv(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed));
  const kv: LinkStorage & { rows: Map<string, unknown> } = {
    rows,
    async get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      rows.set(key, value);
    },
  };
  return kv;
}

function link(overrides: Partial<AmpLink> & { ampThreadId: string }): AmpLink {
  return {
    bbThreadId: "thr_1",
    runnerId: "exe-roster",
    targetName: "Roster Amp",
    createdAt: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

describe("Amp companion link storage", () => {
  it("reads a pre-migration single link as a one-entry list", async () => {
    const legacy = link({ ampThreadId: "T-legacy" });
    const kv = fakeKv({ [legacyLinkKey("thr_1")]: legacy });
    assert.deepEqual(await readLinks(kv, "thr_1"), [legacy]);
  });

  it("keeps the legacy link when a second run is added", async () => {
    const legacy = link({ ampThreadId: "T-legacy" });
    const kv = fakeKv({ [legacyLinkKey("thr_1")]: legacy });

    await saveLink(
      kv,
      link({ ampThreadId: "T-new", createdAt: "2026-08-08T11:00:00.000Z" }),
    );

    const links = await readLinks(kv, "thr_1");
    assert.deepEqual(
      links.map((entry) => entry.ampThreadId),
      ["T-new", "T-legacy"],
    );
    // The legacy row is preserved, not rewritten or deleted.
    assert.deepEqual(kv.rows.get(legacyLinkKey("thr_1")), legacy);
  });

  it("prefers the list key once it exists", async () => {
    const kv = fakeKv({
      [legacyLinkKey("thr_1")]: link({ ampThreadId: "T-legacy" }),
      [linkListKey("thr_1")]: {
        version: 1,
        links: [link({ ampThreadId: "T-list" })],
      },
    });
    assert.deepEqual(
      (await readLinks(kv, "thr_1")).map((entry) => entry.ampThreadId),
      ["T-list"],
    );
  });

  it("refreshes an existing link in place instead of appending", async () => {
    const kv = fakeKv();
    await saveLink(kv, link({ ampThreadId: "T-one" }));
    await saveLink(kv, link({ ampThreadId: "T-one", lastKnownState: "idle" }));

    const links = await readLinks(kv, "thr_1");
    assert.equal(links.length, 1);
    assert.equal(links[0].lastKnownState, "idle");
  });

  it("bounds the stored list and drops the oldest run", async () => {
    const kv = fakeKv();
    for (let index = 0; index < 25; index += 1) {
      await saveLink(
        kv,
        link({
          ampThreadId: `T-${index}`,
          createdAt: new Date(Date.UTC(2026, 7, 8, 0, index)).toISOString(),
        }),
      );
    }
    const links = await readLinks(kv, "thr_1");
    assert.equal(links.length, 20);
    assert.equal(links[0].ampThreadId, "T-24");
    assert.equal(
      links.some((entry) => entry.ampThreadId === "T-0"),
      false,
    );
  });

  it("ignores malformed stored values", async () => {
    const kv = fakeKv({ [linkListKey("thr_1")]: { version: 1, links: "no" } });
    assert.deepEqual(await readLinks(kv, "thr_1"), []);
  });

  it("drops only the unparseable entry, never the rest of the list", async () => {
    const good = link({ ampThreadId: "T-good" });
    const kv = fakeKv({
      [linkListKey("thr_1")]: {
        version: 1,
        links: [{ ampThreadId: "T-broken" }, good],
      },
    });

    assert.deepEqual(
      (await readLinks(kv, "thr_1")).map((entry) => entry.ampThreadId),
      ["T-good"],
    );

    await saveLink(
      kv,
      link({ ampThreadId: "T-new", createdAt: "2026-08-08T12:00:00.000Z" }),
    );
    assert.deepEqual(
      (await readLinks(kv, "thr_1")).map((entry) => entry.ampThreadId),
      ["T-new", "T-good"],
    );
  });

  it("refuses to overwrite a list written by a newer version", async () => {
    const kv = fakeKv({
      [linkListKey("thr_1")]: {
        version: 2,
        links: [link({ ampThreadId: "T-future" })],
      },
    });
    const record = await readLinkRecord(kv, "thr_1");
    assert.equal(record.writable, false);
    assert.deepEqual(
      record.links.map((entry) => entry.ampThreadId),
      ["T-future"],
    );

    await assert.rejects(
      saveLink(kv, link({ ampThreadId: "T-new" })),
      /newer version/,
    );
    assert.deepEqual(
      (await kv.get<{ version: number }>(linkListKey("thr_1")))?.version,
      2,
    );
  });

  it("serializes concurrent writes so no link is lost", async () => {
    const kv = fakeKv();
    const slow = { ...kv, async set(key: string, value: unknown) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      kv.rows.set(key, value);
    } } satisfies LinkStorage;

    await Promise.all([
      saveLink(slow, link({ ampThreadId: "T-a", createdAt: "2026-08-08T10:00:00.000Z" })),
      saveLink(slow, link({ ampThreadId: "T-b", createdAt: "2026-08-08T10:01:00.000Z" })),
      saveLink(slow, link({ ampThreadId: "T-c", createdAt: "2026-08-08T10:02:00.000Z" })),
    ]);

    assert.deepEqual(
      (await readLinks(kv, "thr_1")).map((entry) => entry.ampThreadId),
      ["T-c", "T-b", "T-a"],
    );
  });

  it("keeps a failed write from wedging later writes", async () => {
    const kv = fakeKv({
      [linkListKey("thr_1")]: { version: 2, links: [] },
    });
    await assert.rejects(saveLink(kv, link({ ampThreadId: "T-a" })));
    kv.rows.delete(linkListKey("thr_1"));
    await saveLink(kv, link({ ampThreadId: "T-b" }));
    assert.deepEqual(
      (await readLinks(kv, "thr_1")).map((entry) => entry.ampThreadId),
      ["T-b"],
    );
  });

  it("strips a stored link URL that is not http(s)", async () => {
    const kv = fakeKv({
      [legacyLinkKey("thr_1")]: link({
        ampThreadId: "T-legacy",
        threadUrl: "javascript:alert(1)",
      }),
    });
    assert.equal((await readLinks(kv, "thr_1"))[0].threadUrl, undefined);

    await saveLink(
      kv,
      link({ ampThreadId: "T-new", threadUrl: "https://amp.test/T-new" }),
    );
    const links = await readLinks(kv, "thr_1");
    assert.equal(links.find((e) => e.ampThreadId === "T-new")?.threadUrl,
      "https://amp.test/T-new");
  });
});
