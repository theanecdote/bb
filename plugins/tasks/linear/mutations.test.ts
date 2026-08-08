import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../api/index.js";
import { createLinearMappingStore } from "./store.js";
import {
  createLinearMutationBridge,
  LinearAttachmentError,
} from "./mutations.js";
import type { LinearClient, LinearIssue } from "./types.js";

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
