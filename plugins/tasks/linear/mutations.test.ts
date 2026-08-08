import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../api/index.js";
import { createLinearMappingStore } from "./store.js";
import {
  createLinearMutationBridge,
  LinearAttachmentError,
} from "./mutations.js";
import type { LinearClient, LinearIssue } from "./types.js";
import { LinearApiError } from "./client.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "mutation-test" });
  disposals.push(() => harness.dispose());
  const store = createStore(bb);
  const mappings = createLinearMappingStore(bb.storage.database());
  const project = store.tasks.createProject({
    name: "People",
    prefix: "PER",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Before",
    status: "todo",
  });
  mappings.upsertTeamMapping({
    linearTeamId: "team",
    projectId: project.id,
    teamKey: "PER",
    teamName: "People",
  });
  mappings.upsertIssueMapping({
    linearIssueId: "issue",
    taskId: task.id,
    linearTeamId: "team",
    identifier: task.key,
    url: "https://linear.app/issue",
    linearStateId: "todo",
    linearUpdatedAt: "old",
    active: true,
  });
  const updated: LinearIssue = {
    id: "issue",
    identifier: task.key,
    title: "After",
    description: null,
    priority: 0,
    dueDate: null,
    url: "https://linear.app/issue",
    updatedAt: "new",
    archivedAt: null,
    assignee: { id: "viewer" },
    team: { id: "team", key: "PER", name: "People" },
    state: { id: "review-a", name: "In Review", type: "started", position: 5 },
  };
  const client: LinearClient = {
    viewerAssignedIssues: vi.fn(),
    issuesByIds: vi.fn(),
    teamStates: vi.fn(async () => [
      { id: "review-b", name: "Started", type: "started", position: 1 },
      { id: "review-a", name: "In Review", type: "started", position: 5 },
    ]),
    updateIssue: vi.fn(async () => updated),
    createComment: vi.fn(async () => ({ id: "comment" })),
  };
  return {
    store,
    mappings,
    task,
    updated,
    client,
    bridge: createLinearMutationBridge({ client, mappings }),
  };
}

describe("LinearMutationBridge", () => {
  it("awaits Linear before a synchronous commit and records deterministic in_review state", async () => {
    const h = setup();
    const prepared = await h.bridge.prepareTaskMutation(
      h.task,
      { status: "in_review" },
      "agent",
    );
    expect(h.store.tasks.getTask(h.task.id)?.status).toBe("todo");
    expect(h.client.updateIssue).toHaveBeenCalledWith("issue", {
      stateId: "review-a",
    });
    h.store.transaction(() => prepared.commit(h.store.tasks));
    expect(h.store.tasks.getTask(h.task.id)?.status).toBe("in_review");
    expect(h.mappings.getIssueMappingByTask(h.task.id)?.linearStateId).toBe(
      "review-a",
    );
  });

  it("clears cached workflow states when credentials rotate", async () => {
    const h = setup();
    await h.bridge.prepareTaskMutation(
      h.task,
      { status: "in_review" },
      "agent",
    );
    h.bridge.clearWorkflowStateCache();
    await h.bridge.prepareTaskMutation(
      h.task,
      { status: "in_review" },
      "agent",
    );
    expect(h.client.teamStates).toHaveBeenCalledTimes(2);
  });

  it("binds overlapping state lookup and mutation to one client generation", async () => {
    const h = setup();
    let releaseOld!: (
      states: Awaited<ReturnType<LinearClient["teamStates"]>>,
    ) => void;
    vi.mocked(h.client.teamStates).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    const newClient: LinearClient = {
      ...h.client,
      teamStates: vi.fn(async () => [
        { id: "new-review", name: "In Review", type: "started", position: 1 },
      ]),
      updateIssue: vi.fn(async () => ({
        ...h.updated,
        state: {
          id: "new-review",
          name: "In Review",
          type: "started",
          position: 1,
        },
      })),
    };
    let runtime = { generation: 1, client: h.client };
    const bridge = createLinearMutationBridge({
      client: async () => runtime,
      mappings: h.mappings,
    });

    const first = bridge.prepareTaskMutation(
      h.task,
      { status: "in_review" },
      "agent",
    );
    await vi.waitFor(() => expect(h.client.teamStates).toHaveBeenCalledOnce());
    runtime = { generation: 2, client: newClient };
    bridge.clearWorkflowStateCache();
    releaseOld([
      { id: "old-review", name: "In Review", type: "started", position: 1 },
    ]);
    await first;
    expect(h.client.updateIssue).toHaveBeenCalledWith("issue", {
      stateId: "old-review",
    });
    expect(newClient.updateIssue).not.toHaveBeenCalled();

    await bridge.prepareTaskMutation(h.task, { status: "in_review" }, "agent");
    expect(newClient.teamStates).toHaveBeenCalledOnce();
    expect(newClient.updateIssue).toHaveBeenCalledWith("issue", {
      stateId: "new-review",
    });
    expect(h.client.teamStates).toHaveBeenCalledOnce();
  });

  it("leaves BB unchanged when Linear rejects and bypasses echo for linear-sync", async () => {
    const h = setup();
    vi.mocked(h.client.updateIssue).mockRejectedValueOnce(
      new Error("secret upstream detail"),
    );
    await expect(
      h.bridge.prepareTaskMutation(h.task, { title: "Rejected" }, "cli"),
    ).rejects.toMatchObject({ code: "linear_write_failed" });
    expect(h.store.tasks.getTask(h.task.id)?.title).toBe("Before");
    const inbound = await h.bridge.prepareTaskMutation(
      h.task,
      { title: "Inbound" },
      "linear-sync",
    );
    inbound.commit(h.store.tasks);
    expect(h.store.tasks.getTask(h.task.id)?.title).toBe("Inbound");
    expect(h.client.updateIssue).toHaveBeenCalledTimes(1);
  });

  it("refuses outbound edits and comments from an inactive historical mapping", async () => {
    const h = setup();
    h.mappings.setIssueMappingActive(h.task.id, false);
    await expect(
      h.bridge.prepareTaskMutation(h.task, { title: "Stale edit" }, "user"),
    ).rejects.toMatchObject({
      code: "linear_write_failed",
      message: expect.stringContaining("read-only historical"),
    });
    await expect(
      h.bridge.prepareUserComment(h.task.id, "stale comment", "user"),
    ).rejects.toMatchObject({ code: "linear_write_failed" });
    expect(h.client.updateIssue).not.toHaveBeenCalled();
    expect(h.client.createComment).not.toHaveBeenCalled();
    expect(() => h.bridge.assertAttachmentAllowed(h.task.id)).toThrow(
      LinearAttachmentError,
    );
    expect(h.bridge.isMappedTask(h.task.id)).toBe(true);
  });

  it("preserves Linear rate limiting and retry metadata", async () => {
    const h = setup();
    vi.mocked(h.client.updateIssue).mockRejectedValueOnce(
      new LinearApiError(
        "LINEAR_RATE_LIMITED",
        "Linear is rate limited. Try again later.",
        new Date("2026-08-08T01:00:00Z"),
      ),
    );
    await expect(
      h.bridge.prepareTaskMutation(h.task, { title: "Later" }, "user"),
    ).rejects.toMatchObject({
      code: "linear_rate_limited",
      message: "Linear is rate limited. Try again later.",
      retryAt: "2026-08-08T01:00:00.000Z",
    });
  });

  it("normalizes mapped titles before comparing and writing to Linear", async () => {
    const h = setup();
    await h.bridge.prepareTaskMutation(h.task, { title: "  After  " }, "user");
    expect(h.client.updateIssue).toHaveBeenCalledWith("issue", {
      title: "After",
    });
  });

  it("records mutation diagnostics without erasing sync retry state", () => {
    const h = setup();
    h.mappings.updateSyncState({
      viewerName: "Viewer",
      activeIssueCount: 4,
      lastSuccessfulSyncAt: "2026-08-08T00:00:00.000Z",
      lastAttemptAt: "2026-08-08T00:05:00.000Z",
      lastError: "Linear is rate limited. Try again later.",
      lastErrorCode: "LINEAR_RATE_LIMITED",
      retryAt: "2026-08-08T01:00:00.000Z",
    });

    h.bridge.recordSyncDiagnostic(
      "LINEAR_RATE_LIMITED",
      "A mapped write was rate limited.",
      "2026-08-08T02:00:00.000Z",
    );

    expect(h.mappings.getSyncState()).toEqual({
      lastSuccessfulSyncAt: "2026-08-08T00:00:00.000Z",
      lastAttemptAt: "2026-08-08T00:05:00.000Z",
      lastError: "A mapped write was rate limited.",
      lastErrorCode: "LINEAR_RATE_LIMITED",
      retryAt: "2026-08-08T02:00:00.000Z",
    });
  });

  it("writes user comments only and rejects mapped attachment references", async () => {
    const h = setup();
    await expect(
      h.bridge.prepareUserComment(
        h.task.id,
        "see /api/v1/plugins/tasks/http/attachments/download?x=1",
        "user",
      ),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(() => h.bridge.assertAttachmentAllowed(h.task.id)).toThrow(
      LinearAttachmentError,
    );
    const prepared = await h.bridge.prepareUserComment(
      h.task.id,
      "hello",
      "user",
    );
    prepared.commit(h.store.tasks, {
      taskId: h.task.id,
      kind: "user",
      authorName: "Me",
      presetName: null,
      threadId: null,
      body: "hello",
      notifiedCount: 0,
    });
    expect(h.client.createComment).toHaveBeenCalledWith("issue", "hello");
  });
});
