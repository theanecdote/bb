import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../api/index.js";
import { DEFAULT_COLOR } from "../views/manage/shared.js";
import { createLinearMappingStore } from "./store.js";
import { createLinearSyncService } from "./sync.js";
import { LinearApiError, LinearRequestCanceled } from "./client.js";
import type { LinearClient, LinearIssue } from "./types.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "PER-2165",
    title: "Projected",
    description: "Markdown",
    priority: 2,
    dueDate: "2026-08-20",
    url: "https://linear.app/PER-2165",
    updatedAt: "2026-08-08T00:00:00.000Z",
    archivedAt: null,
    assignee: { id: "viewer" },
    team: { id: "team-per", key: "PER", name: "People" },
    state: { id: "started", name: "Started", type: "started", position: 1 },
    ...overrides,
  };
}

function setup(active: LinearIssue[] = [issue()]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "linear-sync-test",
  });
  disposals.push(() => harness.dispose());
  const database = bb.storage.database();
  const store = createStore(database);
  const mappings = createLinearMappingStore(database);
  const client: LinearClient = {
    viewerAssignedIssues: vi.fn(async () => ({
      viewerId: "viewer",
      viewerName: "Viewer",
      issues: active,
    })),
    issuesByIds: vi.fn(async () => []),
    teamStates: vi.fn(async () => []),
    updateIssue: vi.fn(),
    createComment: vi.fn(),
  };
  const taskEvents = vi.fn(),
    projectEvents = vi.fn(),
    warn = vi.fn();
  const service = createLinearSyncService({
    client,
    mappings,
    store,
    warn,
    publishTaskChanged: taskEvents,
    publishProjectChanged: projectEvents,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });
  return { store, mappings, client, service, taskEvents, projectEvents, warn };
}

describe("Linear projection and reconciliation", () => {
  it("maps fields and states, preserves no-op revisions, and logs unknown states once", async () => {
    const unknown = issue({
      state: { id: "mystery", name: "Mystery", type: "future", position: 1 },
    });
    const h = setup([unknown]);
    expect((await h.service.sync()).ok).toBe(true);
    const project = h.store.tasks.listProjects()[0]!;
    const task = h.store.tasks.listTasks({ projectId: project.id })[0]!;
    expect(project).toMatchObject({ prefix: "PER", color: DEFAULT_COLOR });
    expect(task).toMatchObject({
      key: "PER-2165",
      description: "Markdown",
      priority: "high",
      dueDate: "2026-08-20",
      status: "backlog",
    });
    const cursor = h.store.tasks.listTasksPage({
      projectId: project.id,
      limit: 1,
    }).nextCursor;
    await h.service.sync();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.taskEvents).toHaveBeenCalledTimes(1);
    expect(() =>
      h.store.tasks.listTasksPage({
        projectId: project.id,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      }),
    ).not.toThrow();
  });

  it("validates the complete snapshot before creating any team", async () => {
    const h = setup([
      issue(),
      issue({
        id: "bad",
        identifier: "bad-1",
        team: { id: "bad", key: "bad", name: "Bad" },
      }),
    ]);
    await expect(h.service.sync()).resolves.toMatchObject({
      ok: false,
      error: { code: "LINEAR_MAPPING_ERROR" },
    });
    expect(h.store.tasks.listProjects()).toHaveLength(0);
    expect(h.service.getStatus()).toMatchObject({
      viewerName: null,
      activeIssueCount: 0,
    });
  });

  it("rejects local prefix drift but adopts a remote team name change", async () => {
    const active = [issue()];
    const h = setup(active);
    expect((await h.service.sync()).ok).toBe(true);
    const project = h.store.tasks.listProjects()[0]!;

    h.store.tasks.updateProject(project.id, { prefix: "LOCAL" });
    await expect(h.service.sync()).resolves.toMatchObject({
      ok: false,
      error: { code: "LINEAR_MAPPING_ERROR" },
    });

    h.store.tasks.updateProject(project.id, { prefix: "PER" });
    active[0] = issue({
      team: { id: "team-per", key: "PER", name: "People Operations" },
    });
    expect((await h.service.sync()).ok).toBe(true);
    expect(h.store.tasks.getProject(project.id)?.name).toBe(
      "People Operations",
    );
    expect(h.mappings.getTeamMapping("team-per")?.teamName).toBe(
      "People Operations",
    );
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
    active[0] = issue({
      updatedAt: "2026-08-10T00:00:00.000Z",
      state: { id: "done", name: "Done", type: "completed", position: 2 },
    });
    await h.service.sync();
    expect(h.store.tasks.getTask(task.id)?.status).toBe("done");
  });

  it("reconciles terminal state before archive and later reactivates the same task", async () => {
    const active = [issue()];
    const h = setup(active);
    await h.service.sync();
    const task = h.store.tasks.listTasks()[0]!;
    active.splice(0);
    vi.mocked(h.client.issuesByIds).mockResolvedValueOnce([
      issue({
        archivedAt: "2026-08-09T00:00:00Z",
        state: { id: "done", name: "Done", type: "completed", position: 2 },
      }),
    ]);
    await h.service.sync();
    expect(h.store.tasks.getTask(task.id)?.status).toBe("done");
    expect(h.mappings.getActiveIssueMapping("issue-1")).toBeUndefined();
    active.push(issue());
    await h.service.sync();
    expect(h.mappings.getActiveIssueMapping("issue-1")?.taskId).toBe(task.id);
  });

  it("preserves the old mapped task and creates one active mapping after a cross-team move", async () => {
    const active = [issue()];
    const h = setup(active);
    await h.service.sync();
    const oldTask = h.store.tasks.listTasks()[0]!;

    active[0] = issue({
      identifier: "ENG-42",
      team: { id: "team-eng", key: "ENG", name: "Engineering" },
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(await h.service.sync()).toMatchObject({ ok: true, createdTasks: 1 });
    const tasks = h.store.tasks.listTasks();
    expect(tasks).toHaveLength(2);
    const newTask = tasks.find((task) => task.id !== oldTask.id)!;
    expect(newTask.key).toBe("ENG-42");
    expect(h.mappings.getIssueMappingByTask(oldTask.id)).toMatchObject({
      linearIssueId: "issue-1",
      identifier: "PER-2165",
      active: false,
    });
    expect(h.mappings.getIssueMappingByTask(newTask.id)).toMatchObject({
      linearIssueId: "issue-1",
      identifier: "ENG-42",
      active: true,
    });
    expect(h.mappings.getActiveIssueMapping("issue-1")?.taskId).toBe(
      newTask.id,
    );

    expect(await h.service.sync()).toMatchObject({
      ok: true,
      createdTasks: 0,
      updatedTasks: 0,
    });
    expect(h.store.tasks.listTasks()).toHaveLength(2);
    expect(h.mappings.listActiveIssueMappings()).toHaveLength(1);
  });

  it("returns one promise for concurrent calls and records safe failures", async () => {
    const h = setup([]);
    let release!: () => void;
    vi.mocked(h.client.viewerAssignedIssues).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ viewerId: "viewer", viewerName: "Viewer", issues: [] });
        }),
    );
    const first = h.service.sync(),
      second = h.service.sync();
    expect(first).toBe(second);
    release();
    await first;
    vi.mocked(h.client.viewerAssignedIssues).mockRejectedValueOnce(
      new Error("secret details"),
    );
    const failed = await h.service.sync();
    expect(failed).toMatchObject({
      ok: false,
      error: { message: "Linear synchronization failed" },
    });
    expect(h.warn).toHaveBeenCalledWith("Linear sync internal failure: Error");
    expect(h.warn).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
    vi.mocked(h.client.viewerAssignedIssues).mockRejectedValueOnce(
      Object.assign(new Error("database details"), { code: "SQLITE_BUSY" }),
    );
    await h.service.sync();
    expect(h.warn).toHaveBeenCalledWith(
      "Linear sync internal failure: Error (SQLITE_BUSY)",
    );
    vi.mocked(h.client.viewerAssignedIssues).mockRejectedValueOnce("raw secret");
    await h.service.sync();
    expect(h.warn).toHaveBeenCalledWith(
      "Linear sync internal failure: non-error rejection",
    );
    expect(h.warn).not.toHaveBeenCalledWith(expect.stringContaining("raw secret"));
    expect(h.service.getStatus().lastSuccessfulSyncAt).toBe(
      "2026-08-08T12:00:00.000Z",
    );
  });

  it("persists typed failure status across recreation without changing successful data", async () => {
    const h = setup([]);
    await h.service.sync();
    const success = h.service.getStatus().lastSuccessfulSyncAt;
    vi.mocked(h.client.viewerAssignedIssues).mockRejectedValueOnce(
      new LinearApiError(
        "LINEAR_RATE_LIMITED",
        "Linear is rate limited. Try again later.",
        new Date("2026-08-08T13:00:00.000Z"),
      ),
    );
    await h.service.sync();
    const recreated = createLinearSyncService({
      client: h.client,
      mappings: h.mappings,
      store: h.store,
    });
    expect(recreated.getStatus()).toMatchObject({
      lastSuccessfulSyncAt: success,
      retryAt: "2026-08-08T13:00:00.000Z",
      lastError: {
        code: "LINEAR_RATE_LIMITED",
        message: "Linear is rate limited. Try again later.",
      },
    });
  });

  it("does not persist caller cancellation as an API failure", async () => {
    const h = setup([]);
    vi.mocked(h.client.viewerAssignedIssues).mockRejectedValueOnce(
      new LinearRequestCanceled(),
    );
    await expect(h.service.sync(AbortSignal.abort())).rejects.toBeInstanceOf(
      LinearRequestCanceled,
    );
    expect(h.mappings.getSyncState()).toMatchObject({
      lastAttemptAt: null,
      lastError: null,
      lastErrorCode: null,
    });
  });

  it("uses one client snapshot for the complete flight and forwards its signal", async () => {
    const h = setup([]);
    const controller = new AbortController();
    const first = h.client;
    const second = { ...h.client, viewerAssignedIssues: vi.fn() };
    let selected: LinearClient = first;
    let release!: () => void;
    vi.mocked(first.viewerAssignedIssues).mockImplementationOnce((signal) => {
      expect(signal).toBe(controller.signal);
      return new Promise((resolve) => {
        release = () =>
          resolve({ viewerId: "viewer", viewerName: "Viewer", issues: [] });
      });
    });
    const service = createLinearSyncService({
      client: async () => selected,
      mappings: h.mappings,
      store: h.store,
    });
    const flight = service.sync(controller.signal);
    await vi.waitFor(() =>
      expect(first.viewerAssignedIssues).toHaveBeenCalledOnce(),
    );
    selected = second;
    expect(service.sync()).toBe(flight);
    release();
    await flight;
    expect(second.viewerAssignedIssues).not.toHaveBeenCalled();
  });
});
