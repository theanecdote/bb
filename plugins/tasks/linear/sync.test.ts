import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../api/index.js";
import { DEFAULT_COLOR } from "../views/manage/shared.js";
import { createLinearMappingStore } from "./store.js";
import { createLinearSyncService } from "./sync.js";
import type { LinearClient, LinearIssue } from "./types.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposals.length) await disposals.pop()!(); });

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1", identifier: "PER-2165", title: "Projected", description: "Markdown",
    priority: 2, dueDate: "2026-08-20", url: "https://linear.app/PER-2165",
    updatedAt: "2026-08-08T00:00:00.000Z", archivedAt: null, assignee: { id: "viewer" },
    team: { id: "team-per", key: "PER", name: "People" },
    state: { id: "started", name: "Started", type: "started", position: 1 },
    ...overrides,
  };
}

function setup(active: LinearIssue[] = [issue()]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "linear-sync-test" });
  disposals.push(() => harness.dispose());
  const store = createStore(bb);
  const mappings = createLinearMappingStore(bb.storage.database());
  const client: LinearClient = {
    viewerAssignedIssues: vi.fn(async () => ({ viewerId: "viewer", issues: active })),
    issuesByIds: vi.fn(async () => []), teamStates: vi.fn(async () => []),
    updateIssue: vi.fn(), createComment: vi.fn(),
  };
  const taskEvents = vi.fn(), projectEvents = vi.fn(), warn = vi.fn();
  const service = createLinearSyncService({ client, mappings, store, warn,
    publishTaskChanged: taskEvents, publishProjectChanged: projectEvents,
    now: () => new Date("2026-08-08T12:00:00.000Z") });
  return { store, mappings, client, service, taskEvents, projectEvents, warn };
}

describe("Linear projection and reconciliation", () => {
  it("maps fields and states, preserves no-op revisions, and logs unknown states once", async () => {
    const unknown = issue({ state: { id: "mystery", name: "Mystery", type: "future", position: 1 } });
    const h = setup([unknown]);
    expect((await h.service.sync()).ok).toBe(true);
    const project = h.store.tasks.listProjects()[0]!;
    const task = h.store.tasks.listTasks({ projectId: project.id })[0]!;
    expect(project).toMatchObject({ prefix: "PER", color: DEFAULT_COLOR });
    expect(task).toMatchObject({ key: "PER-2165", description: "Markdown", priority: "high", dueDate: "2026-08-20", status: "backlog" });
    const cursor = h.store.tasks.listTasksPage({ projectId: project.id, limit: 1 }).nextCursor;
    await h.service.sync();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.taskEvents).toHaveBeenCalledTimes(1);
    expect(() => h.store.tasks.listTasksPage({ projectId: project.id, limit: 1, ...(cursor ? { cursor } : {}) })).not.toThrow();
  });

  it("validates the complete snapshot before creating any team", async () => {
    const h = setup([issue(), issue({ id: "bad", identifier: "bad-1", team: { id: "bad", key: "bad", name: "Bad" } })]);
    await expect(h.service.sync()).resolves.toMatchObject({ ok: false, error: { code: "LINEAR_MAPPING_ERROR" } });
    expect(h.store.tasks.listProjects()).toHaveLength(0);
  });

  it("preserves in_review for an unchanged state id and replaces it when state id changes", async () => {
    const active = [issue()];
    const h = setup(active);
    await h.service.sync();
    const task = h.store.tasks.listTasks()[0]!;
    h.store.tasks.updateTask(task.id, { status: "in_review" });
    active[0] = issue({ updatedAt: "2026-08-09T00:00:00.000Z" });
    await h.service.sync();
    expect(h.store.tasks.getTask(task.id)?.status).toBe("in_review");
    active[0] = issue({ updatedAt: "2026-08-10T00:00:00.000Z", state: { id: "done", name: "Done", type: "completed", position: 2 } });
    await h.service.sync();
    expect(h.store.tasks.getTask(task.id)?.status).toBe("done");
  });

  it("reconciles terminal state before archive and later reactivates the same task", async () => {
    const active = [issue()];
    const h = setup(active);
    await h.service.sync();
    const task = h.store.tasks.listTasks()[0]!;
    active.splice(0);
    vi.mocked(h.client.issuesByIds).mockResolvedValueOnce([issue({ archivedAt: "2026-08-09T00:00:00Z", state: { id: "done", name: "Done", type: "completed", position: 2 } })]);
    await h.service.sync();
    expect(h.store.tasks.getTask(task.id)?.status).toBe("done");
    expect(h.mappings.getIssueMapping("issue-1")?.active).toBe(false);
    active.push(issue());
    await h.service.sync();
    expect(h.mappings.getIssueMapping("issue-1")?.taskId).toBe(task.id);
  });

  it("returns one promise for concurrent calls and records safe failures", async () => {
    const h = setup([]);
    let release!: () => void;
    vi.mocked(h.client.viewerAssignedIssues).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ viewerId: "viewer", issues: [] }); }));
    const first = h.service.sync(), second = h.service.sync();
    expect(first).toBe(second);
    release(); await first;
    vi.mocked(h.client.viewerAssignedIssues).mockRejectedValueOnce(new Error("secret details"));
    const failed = await h.service.sync();
    expect(failed).toMatchObject({ ok: false, error: { message: "Linear synchronization failed" } });
    expect(h.service.getStatus().lastSuccessfulSyncAt).toBe("2026-08-08T12:00:00.000Z");
  });
});
