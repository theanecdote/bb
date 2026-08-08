import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db/index.js";
import { createLinearMappingStore } from "./store.js";

describe("Linear mapping store", () => {
  it("durably identifies mapped projects and reuses issue mappings", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "linear-store-test",
    });
    try {
      const db = bb.storage.database();
      const tasks = createTasksStore(db);
      const mappings = createLinearMappingStore(db);
      const mapped = tasks.createProject({
        name: "People",
        prefix: "PER",
        color: "blue",
      });
      const unmapped = tasks.createProject({
        name: "Other",
        prefix: "OTH",
        color: "blue",
      });
      const task = tasks.createTask({
        projectId: mapped.id,
        number: 2165,
        title: "Issue",
      });
      mappings.upsertTeamMapping({
        linearTeamId: "team-1",
        projectId: mapped.id,
        teamKey: "PER",
        teamName: "People",
      });
      const input = {
        linearIssueId: "issue-1",
        taskId: task.id,
        linearTeamId: "team-1",
        identifier: "PER-2165",
        url: "https://linear.app/issue/PER-2165",
        linearStateId: "state-1",
        linearUpdatedAt: "2026-08-08T00:00:00.000Z",
        active: true,
      };

      expect(mappings.upsertIssueMapping(input)).toEqual(
        mappings.upsertIssueMapping(input),
      );
      expect(mappings.getIssueMapping("issue-1")?.taskId).toBe(task.id);
      expect(mappings.isMappedProject(mapped.id)).toBe(true);
      expect(mappings.isMappedProject(unmapped.id)).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("cascades mappings when Tasks entities are removed", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "linear-cascade-test",
    });
    try {
      const db = bb.storage.database();
      const tasks = createTasksStore(db);
      const mappings = createLinearMappingStore(db);
      const project = tasks.createProject({
        name: "People",
        prefix: "PER",
        color: "blue",
      });
      const task = tasks.createTask({ projectId: project.id, title: "Issue" });
      mappings.upsertTeamMapping({
        linearTeamId: "team-1",
        projectId: project.id,
        teamKey: "PER",
        teamName: "People",
      });
      mappings.upsertIssueMapping({
        linearIssueId: "issue-1",
        taskId: task.id,
        linearTeamId: "team-1",
        identifier: "PER-1",
        url: "https://linear.app/issue/PER-1",
        linearStateId: "state-1",
        linearUpdatedAt: "2026-08-08T00:00:00.000Z",
        active: true,
      });
      tasks.deleteProject(project.id);
      expect(mappings.getTeamMapping("team-1")).toBeUndefined();
      expect(mappings.getIssueMapping("issue-1")).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });
});
