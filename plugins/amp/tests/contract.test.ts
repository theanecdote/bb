import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AmpLinkSchema,
  hashRemote,
  orderLinks,
  parseCompanionPort,
  parseConfig,
  pendingCreateKey,
  sanitizeThreadUrl,
  selectLink,
  selectTarget,
  toAcpChildren,
  truncate,
  upsertLink,
  type AmpLink,
} from "../contract";

function link(ampThreadId: string, createdAt: string): AmpLink {
  return {
    bbThreadId: "thr_1",
    ampThreadId,
    runnerId: "exe-roster",
    targetName: "Roster Amp",
    createdAt,
  };
}

function acpRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thr_child",
    providerId: "acp-amp",
    title: "Fix the parser",
    titleFallback: null,
    status: "idle",
    runtime: { displayStatus: "active" },
    createdAt: 1_000,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("bb-plugin-amp contract helpers", () => {
  it("parses explicit target mappings", () => {
    const config = parseConfig(
      JSON.stringify({
        targets: [
          {
            name: "Roster Amp",
            runnerId: "exe-roster",
            bbHostId: "host_123",
            repoRoot: "/home/exedev/repos/roster",
            companionClientPath:
              "/home/exedev/.config/amp/plugins/bb-companion-client.mjs",
          },
        ],
      }),
    );
    assert.equal(config.targets[0].runnerId, "exe-roster");
  });

  it("selects exactly one host/path target", () => {
    const target = {
      name: "Roster Amp",
      runnerId: "exe-roster",
      bbHostId: "host_123",
      repoRoot: "/home/exedev/repos/roster",
      companionClientPath:
        "/home/exedev/.config/amp/plugins/bb-companion-client.mjs",
    };
    assert.equal(
      selectTarget([target], "host_123", "/home/exedev/repos/roster"),
      target,
    );
    assert.equal(
      selectTarget([target], "host_999", "/home/exedev/repos/roster"),
      null,
    );
    assert.equal(
      selectTarget([target, target], "host_123", "/home/exedev/repos/roster"),
      null,
    );
  });

  it("hashes repo remotes without exposing the remote string", () => {
    const first = hashRemote("https://example.test/repo.git");
    const second = hashRemote("https://example.test/repo.git");
    assert.equal(first, second);
    assert.equal(first.length, 64);
  });

  it("bounds handoff text", () => {
    assert.equal(truncate("abc", 10), "abc");
    assert.match(truncate("abcdef", 3), /\[truncated\]$/);
  });

  it("validates the companion port", () => {
    assert.equal(parseCompanionPort("43931"), 43931);
    assert.throws(() => parseCompanionPort("0"), /valid TCP port/);
  });
});

describe("companion link list", () => {
  const older = link("T-old", "2026-08-08T10:00:00.000Z");
  const newer = link("T-new", "2026-08-08T11:00:00.000Z");

  it("orders newest first and drops duplicate Amp threads", () => {
    assert.deepEqual(
      orderLinks([older, newer, { ...older, lastKnownState: "idle" }]).map(
        (entry) => entry.ampThreadId,
      ),
      ["T-new", "T-old"],
    );
  });

  it("adds a run without overwriting earlier runs", () => {
    assert.deepEqual(
      upsertLink([older], newer).map((entry) => entry.ampThreadId),
      ["T-new", "T-old"],
    );
  });

  it("replaces an existing run in place", () => {
    const refreshed = { ...older, lastKnownState: "failed" as const };
    const links = upsertLink([newer, older], refreshed);
    assert.equal(links.length, 2);
    assert.equal(links[1].lastKnownState, "failed");
  });

  it("sorts an unparseable createdAt oldest, as the panel does", () => {
    const broken = link("T-broken", "not a date");
    assert.deepEqual(
      orderLinks([broken, older]).map((entry) => entry.ampThreadId),
      ["T-old", "T-broken"],
    );
    assert.equal(selectLink([broken, older])?.ampThreadId, "T-old");
  });

  it("breaks a same-millisecond tie by write recency", () => {
    const first = link("T-first", "2026-08-08T10:00:00.000Z");
    const second = link("T-second", "2026-08-08T10:00:00.000Z");
    assert.equal(selectLink(upsertLink([first], second))?.ampThreadId, "T-second");
    assert.equal(selectLink(upsertLink([second], first))?.ampThreadId, "T-first");
  });

  it("selects the newest run by default and any run by id", () => {
    assert.equal(selectLink([older, newer])?.ampThreadId, "T-new");
    assert.equal(selectLink([older, newer], "T-old")?.ampThreadId, "T-old");
    assert.equal(selectLink([older, newer], "T-missing"), null);
    assert.equal(selectLink([]), null);
  });

  it("scopes create idempotency to one explicit send invocation", () => {
    assert.equal(pendingCreateKey("thr_1"), "pending-create:thr_1");
    assert.equal(pendingCreateKey("thr_1", "inv-a"), "pending-create:thr_1:inv-a");
    assert.notEqual(
      pendingCreateKey("thr_1", "inv-a"),
      pendingCreateKey("thr_1", "inv-b"),
    );
  });
});

describe("companion thread URLs", () => {
  it("keeps http(s) links and drops everything else", () => {
    assert.equal(
      sanitizeThreadUrl("https://ampcode.test/threads/T-1"),
      "https://ampcode.test/threads/T-1",
    );
    assert.equal(sanitizeThreadUrl("http://localhost:3000/t"), "http://localhost:3000/t");
    assert.equal(sanitizeThreadUrl("javascript:alert(1)"), undefined);
    assert.equal(sanitizeThreadUrl("data:text/html,<script>"), undefined);
    assert.equal(sanitizeThreadUrl("file:///etc/passwd"), undefined);
    assert.equal(sanitizeThreadUrl("/threads/T-1"), undefined);
    assert.equal(sanitizeThreadUrl(undefined), undefined);
  });

  it("strips a rejected URL when parsing a stored link", () => {
    const parsed = AmpLinkSchema.parse({
      bbThreadId: "thr_1",
      ampThreadId: "T-1",
      runnerId: "exe-roster",
      targetName: "Roster Amp",
      createdAt: "2026-08-08T10:00:00.000Z",
      threadUrl: "javascript:alert(1)",
    });
    assert.equal(parsed.threadUrl, undefined);
  });
});

describe("native ACP child discovery", () => {
  it("keeps only live acp-amp children, newest first", () => {
    const children = toAcpChildren([
      acpRow({ id: "thr_a", createdAt: 1 }),
      acpRow({ id: "thr_b", createdAt: 2 }),
      acpRow({ id: "thr_claude", providerId: "claude-code" }),
      acpRow({ id: "thr_archived", archivedAt: 5 }),
      acpRow({ id: "thr_deleted", deletedAt: 5 }),
      { unexpected: "shape" },
    ]);
    assert.deepEqual(
      children.map((child) => child.bbThreadId),
      ["thr_b", "thr_a"],
    );
  });

  it("prefers live display status and falls back through titles", () => {
    const [child] = toAcpChildren([
      acpRow({ title: null, titleFallback: "Untitled child" }),
    ]);
    assert.equal(child.status, "active");
    assert.equal(child.title, "Untitled child");

    const [bare] = toAcpChildren([
      acpRow({ title: null, titleFallback: null, runtime: undefined }),
    ]);
    assert.equal(bare.status, "idle");
    assert.equal(bare.title, "thr_child");
  });

  it("bounds the discovered children", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      acpRow({ id: `thr_${index}`, createdAt: index }),
    );
    assert.equal(toAcpChildren(rows).length, 20);
  });
});
