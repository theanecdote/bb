import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import type { BbPluginApi } from "@bb/plugin-sdk";

// `@bb/plugin-sdk` is a types-only package in this checkout, and the companion
// transport talks to an enrolled host. Both are replaced so the real RPC
// handlers can run in-process.
// `exports` replaced the deprecated `namedExports` in Node 24; @types/node
// has not caught up, so the option object is typed locally.
type ModuleMock = NonNullable<Parameters<typeof mock.module>[1]> & {
  exports: Record<string, unknown>;
};

mock.module("@bb/plugin-sdk", {
  exports: { defineRpcContract: (contract: unknown) => contract },
} as ModuleMock);

type CompanionCall = { method: string; path: string; body?: unknown };

const companionCalls: CompanionCall[] = [];
let createdThreads = 0;
let failNextCreate = false;
let failNextCreateWith: { code: string; message: string } | null = null;
let threadUrlOverride: string | null = null;

mock.module(new URL("../host-client.ts", import.meta.url).href, {
  exports: {
    requestThroughHost: async (
      _bb: unknown,
      _hostId: string,
      _clientPath: string,
      request: CompanionCall,
    ) => {
      companionCalls.push({
        method: request.method,
        path: request.path,
        body: request.body,
      });
      if (request.method === "POST" && request.path === "/v1/threads") {
        if (failNextCreate) {
          failNextCreate = false;
          throw new Error("companion unreachable");
        }
        if (failNextCreateWith !== null) {
          const body = failNextCreateWith;
          failNextCreateWith = null;
          return { ok: false, status: 409, body };
        }
        createdThreads += 1;
        const threadId = `T-${createdThreads}`;
        return {
          ok: true,
          status: 201,
          body: {
            threadId,
            state: "created",
            threadUrl: threadUrlOverride ?? `https://amp.test/${threadId}`,
          },
        };
      }
      if (request.path.endsWith("/cancel")) {
        return { ok: true, status: 200, body: { state: "cancelled" } };
      }
      if (request.path.includes("/messages") && request.method === "GET") {
        return {
          ok: true,
          status: 200,
          body: {
            messages: [
              { id: `${request.path}-m1`, role: "assistant", text: "hello" },
            ],
            nextOffset: null,
          },
        };
      }
      if (request.path.includes("/messages")) {
        return { ok: true, status: 200, body: { state: "running" } };
      }
      return { ok: true, status: 200, body: { state: "idle" } };
    },
  },
} as ModuleMock);

const TARGET = {
  name: "Roster Amp",
  runnerId: "exe-roster",
  bbHostId: "host_1",
  repoRoot: "/home/exedev/repos/roster",
  companionClientPath: "/home/exedev/.config/amp/plugins/bb-companion-client.mjs",
};

type Handlers = Record<string, (input: any) => Promise<any>>;

type HarnessOptions = {
  childThreads?: unknown[];
  targets?: unknown[];
  companionSecret?: string;
  workspaceProvisionType?: string;
  dirty?: boolean;
  gitRemoteUrl?: string | null;
  environmentStatus?: unknown;
};

function fakeBb(options: HarnessOptions = {}) {
  const rows = new Map<string, unknown>();
  const published: string[] = [];
  const handlers: Handlers = {};
  const bb = {
    pluginId: "amp",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {
      define: () => ({
        get: async () => ({
          configJson: JSON.stringify({ targets: options.targets ?? [TARGET] }),
          companionPort: "43931",
          companionSecret: options.companionSecret ?? "s".repeat(32),
        }),
        onChange() {},
      }),
    },
    storage: {
      kv: {
        async get(key: string) {
          return rows.get(key);
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
      },
    },
    rpc: {
      register(_contract: unknown, registered: Handlers) {
        Object.assign(handlers, registered);
      },
    },
    realtime: {
      publish(channel: string) {
        published.push(channel);
      },
    },
    sdk: {
      threads: {
        get: async () => ({
          id: "thr_1",
          projectId: "prj_1",
          environmentId: "env_1",
          title: "Plan the migration",
          titleFallback: null,
        }),
        output: async () => ({ output: "Do the thing." }),
        list: async () => options.childThreads ?? [],
      },
      environments: {
        get: async () => ({
          hostId: "host_1",
          path: "/home/exedev/repos/roster",
          workspaceProvisionType:
            options.workspaceProvisionType ?? "existing-checkout",
        }),
        status: async () =>
          options.environmentStatus ?? {
            outcome: "available",
            workspace: {
              checkout: {
                kind: "branch",
                branchName: "main",
                headSha: "abc123",
              },
              workingTree: {
                hasUncommittedChanges: options.dirty ?? false,
              },
            },
          },
      },
      projects: {
        get: async () => ({
          name: "roster",
          gitRemoteUrl: options.gitRemoteUrl ?? null,
        }),
      },
    },
  } as unknown as BbPluginApi;
  return { bb, handlers, rows, published };
}

function acpChild(id: string, createdAt: number, overrides = {}) {
  return {
    id,
    providerId: "acp-amp",
    title: `Child ${id}`,
    titleFallback: null,
    status: "idle",
    runtime: { displayStatus: "active" },
    createdAt,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

let plugin: (bb: BbPluginApi) => Promise<void>;

async function start(options: HarnessOptions = {}) {
  const harness = fakeBb(options);
  await plugin(harness.bb);
  return harness;
}

describe("Amp plugin RPC handlers", () => {
  before(async () => {
    plugin = (await import("../server")).default;
  });

  it("keeps earlier links when a new explicit send runs", async () => {
    companionCalls.length = 0;
    const { handlers } = await start();

    const first = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    const second = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-b",
    });

    assert.notEqual(first.link.ampThreadId, second.link.ampThreadId);
    assert.deepEqual(
      second.links.map((entry: { ampThreadId: string }) => entry.ampThreadId),
      [second.link.ampThreadId, first.link.ampThreadId],
    );
  });

  it("reuses one request id when a single send invocation is retried", async () => {
    companionCalls.length = 0;
    const { handlers, rows } = await start();

    failNextCreate = true;
    await assert.rejects(
      handlers.sendToAmp({
        threadId: "thr_1",
        mode: "high",
        invocationId: "inv-same",
      }),
      /Companion is unavailable/,
    );
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-same",
    });

    const requestIds = companionCalls
      .filter((call) => call.path === "/v1/threads")
      .map((call) => (call.body as { requestId: string }).requestId);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1]);
    // The record survives success, so a replay can still be recognized.
    assert.equal(rows.has("pending-create:thr_1:inv-same"), true);

    const fresh = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-next",
    });
    assert.equal(fresh.links.length, 2);
  });

  it("replays a completed invocation instead of creating a second thread", async () => {
    companionCalls.length = 0;
    const { handlers } = await start();

    const first = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-lost-response",
    });
    // The client never saw the response and clicked Send again.
    const replay = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-lost-response",
    });

    assert.equal(replay.link.ampThreadId, first.link.ampThreadId);
    assert.equal(replay.links.length, 1);
    assert.equal(
      companionCalls.filter((call) => call.path === "/v1/threads").length,
      1,
    );
  });

  it("re-sends when a completed invocation's link is gone", async () => {
    companionCalls.length = 0;
    const { handlers, rows } = await start();
    const first = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    rows.set("links:thr_1", { version: 1, links: [] });

    const replay = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    assert.notEqual(replay.link.ampThreadId, first.link.ampThreadId);
    const creates = companionCalls.filter((call) => call.path === "/v1/threads");
    assert.equal(creates.length, 2);
    // Same invocation, so the companion still sees one request id.
    assert.equal(
      (creates[0].body as { requestId: string }).requestId,
      (creates[1].body as { requestId: string }).requestId,
    );
  });

  it("routes companion operations to the selected Amp thread", async () => {
    companionCalls.length = 0;
    const { handlers } = await start();
    const first = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-b",
    });

    companionCalls.length = 0;
    await handlers.getMessages({
      threadId: "thr_1",
      ampThreadId: first.link.ampThreadId,
      offset: 0,
    });
    await handlers.sendFollowup({
      threadId: "thr_1",
      ampThreadId: first.link.ampThreadId,
      message: "keep going",
    });
    await handlers.cancelAmp({
      threadId: "thr_1",
      ampThreadId: first.link.ampThreadId,
    });

    for (const call of companionCalls) {
      assert.match(call.path, new RegExp(`/${first.link.ampThreadId}(/|$)`));
    }
  });

  it("defaults to the newest link and rejects unknown Amp threads", async () => {
    const { handlers } = await start();
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    const second = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-b",
    });

    const refreshed = await handlers.refreshStatus({ threadId: "thr_1" });
    assert.equal(refreshed.link.ampThreadId, second.link.ampThreadId);
    await assert.rejects(
      handlers.cancelAmp({ threadId: "thr_1", ampThreadId: "T-nope" }),
      /not linked to this BB thread/,
    );
  });

  it("still allows sending while links already exist", async () => {
    const { handlers } = await start();
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    const panel = await handlers.getPanelState({ threadId: "thr_1" });
    assert.equal(panel.canSend, true);
    assert.equal(panel.reason, null);
  });

  it("surfaces a legacy single link and selects it by id", async () => {
    const { handlers, rows } = await start();
    const legacy = {
      bbThreadId: "thr_1",
      ampThreadId: "T-legacy",
      runnerId: TARGET.runnerId,
      targetName: TARGET.name,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastKnownState: "idle",
    };
    rows.set("link:thr_1", legacy);

    const panel = await handlers.getPanelState({
      threadId: "thr_1",
      ampThreadId: "T-legacy",
    });
    assert.equal(panel.link.ampThreadId, "T-legacy");
    assert.deepEqual(
      panel.links.map((entry: { ampThreadId: string }) => entry.ampThreadId),
      ["T-legacy"],
    );
  });

  it("falls back to the newest link when the selection no longer exists", async () => {
    const { handlers } = await start();
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    const second = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-b",
    });

    const panel = await handlers.getPanelState({
      threadId: "thr_1",
      ampThreadId: "T-evicted",
    });
    assert.equal(panel.link.ampThreadId, second.link.ampThreadId);
  });

  it("returns status and the matching transcript page in one snapshot", async () => {
    companionCalls.length = 0;
    const { handlers } = await start();
    const first = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-b",
    });

    companionCalls.length = 0;
    const snapshot = await handlers.getRunSnapshot({
      threadId: "thr_1",
      ampThreadId: first.link.ampThreadId,
      offset: 0,
    });

    assert.equal(snapshot.link.ampThreadId, first.link.ampThreadId);
    assert.equal(snapshot.status.state, "idle");
    assert.equal(snapshot.page.messages.length, 1);
    for (const call of companionCalls) {
      assert.match(call.path, new RegExp(`/${first.link.ampThreadId}(/|\\?|$)`));
    }

    // The refreshed state is persisted for the related-runs list.
    const panel = await handlers.getPanelState({
      threadId: "thr_1",
      ampThreadId: first.link.ampThreadId,
    });
    assert.equal(panel.link.lastKnownState, "idle");
  });

  it("returns an empty snapshot for an unlinked thread", async () => {
    const { handlers } = await start();
    assert.deepEqual(
      await handlers.getRunSnapshot({ threadId: "thr_1", offset: 0 }),
      { link: null, status: null, page: null },
    );
  });

  it("keeps target configuration off the wire", async () => {
    const { handlers } = await start({
      targets: [{ ...TARGET, repoRemote: "https://example.test/roster.git" }],
      gitRemoteUrl: "https://example.test/roster.git",
    });
    const panel = await handlers.getPanelState({ threadId: "thr_1" });
    assert.deepEqual(panel.selectedTarget, {
      name: TARGET.name,
      runnerId: TARGET.runnerId,
    });
    assert.equal("targets" in panel, false);
    assert.equal(JSON.stringify(panel).includes("companionClientPath"), false);
    assert.equal(JSON.stringify(panel).includes("example.test"), false);
  });

  it("drops a companion thread URL that is not http(s)", async () => {
    companionCalls.length = 0;
    threadUrlOverride = "javascript:alert(1)";
    const { handlers } = await start();
    const created = await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    threadUrlOverride = null;
    assert.equal(created.link.threadUrl, undefined);
  });

  it("blocks sending when the target repo identity does not match", async () => {
    const { handlers } = await start({
      targets: [{ ...TARGET, repoRemote: "https://example.test/other.git" }],
      gitRemoteUrl: "https://example.test/roster.git",
    });
    const panel = await handlers.getPanelState({ threadId: "thr_1" });
    assert.match(panel.reason, /repo identity does not match/);
    assert.equal(panel.canSend, false);
    await assert.rejects(
      handlers.sendToAmp({ threadId: "thr_1", mode: "high" }),
      /repo identity does not match/,
    );
  });

  it("blocks sending from a dirty managed worktree", async () => {
    const { handlers } = await start({
      workspaceProvisionType: "managed-worktree",
      dirty: true,
    });
    const panel = await handlers.getPanelState({ threadId: "thr_1" });
    assert.match(panel.reason, /uncommitted changes/);
    assert.equal(panel.canSend, false);
  });

  it("keeps showing links when BB cannot inspect the checkout", async () => {
    const { handlers, rows } = await start({
      environmentStatus: {
        outcome: "unavailable",
        failure: { message: "host offline" },
      },
    });
    rows.set("links:thr_1", {
      version: 1,
      links: [
        {
          bbThreadId: "thr_1",
          ampThreadId: "T-existing",
          runnerId: TARGET.runnerId,
          targetName: TARGET.name,
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    const panel = await handlers.getPanelState({ threadId: "thr_1" });
    assert.equal(panel.link.ampThreadId, "T-existing");
    assert.equal(panel.canSend, false);
    assert.match(panel.reason, /host offline/);
  });

  it("refuses to talk to the companion without a usable secret", async () => {
    const { handlers } = await start({ companionSecret: "short" });
    await assert.rejects(
      handlers.sendToAmp({ threadId: "thr_1", mode: "high" }),
      /Configure companionSecret/,
    );
  });

  it("surfaces the companion's typed error", async () => {
    const { handlers } = await start();
    failNextCreateWith = { code: "RUNNER_BUSY", message: "runner is busy" };
    await assert.rejects(
      handlers.sendToAmp({ threadId: "thr_1", mode: "high" }),
      /RUNNER_BUSY: runner is busy/,
    );
  });

  it("reports a link whose target was removed from the config", async () => {
    const { handlers, rows } = await start();
    await handlers.sendToAmp({
      threadId: "thr_1",
      mode: "high",
      invocationId: "inv-a",
    });
    const stored = rows.get("links:thr_1") as {
      links: { runnerId: string }[];
    };
    stored.links[0].runnerId = "gone-runner";

    await assert.rejects(
      handlers.refreshStatus({ threadId: "thr_1" }),
      /no longer configured/,
    );
  });

  it("reports native ACP children without linking or storing them", async () => {
    const { handlers, rows } = await start({
      childThreads: [
        acpChild("thr_acp_1", 2_000),
        acpChild("thr_acp_2", 3_000),
        acpChild("thr_other", 4_000, { providerId: "claude-code" }),
      ],
    });

    const panel = await handlers.getPanelState({ threadId: "thr_1" });
    assert.deepEqual(
      panel.acpChildren.map((child: { bbThreadId: string }) => child.bbThreadId),
      ["thr_acp_2", "thr_acp_1"],
    );
    assert.equal(panel.acpChildren[0].status, "active");
    assert.deepEqual(panel.links, []);
    assert.equal([...rows.keys()].some((key) => key.includes("thr_acp")), false);
  });

  it("degrades to no ACP children when BB cannot list them", async () => {
    const harness = await start();
    (harness.bb.sdk.threads as unknown as { list: () => Promise<never> }).list =
      async () => {
        throw new Error("listing unavailable");
      };
    const panel = await harness.handlers.getPanelState({ threadId: "thr_1" });
    assert.deepEqual(panel.acpChildren, []);
  });
});
