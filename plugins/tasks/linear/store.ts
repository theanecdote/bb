import type { BbPluginApi } from "@bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export interface LinearTeamMapping {
  linearTeamId: string;
  projectId: string;
  teamKey: string;
  teamName: string;
}

export interface LinearIssueMapping {
  linearIssueId: string;
  taskId: string;
  linearTeamId: string;
  identifier: string;
  url: string;
  linearStateId: string;
  linearUpdatedAt: string;
  active: boolean;
}

export interface LinearSyncState {
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

interface TeamRow {
  linear_team_id: string;
  project_id: string;
  team_key: string;
  team_name: string;
}

interface IssueRow {
  linear_issue_id: string;
  task_id: string;
  linear_team_id: string;
  identifier: string;
  url: string;
  linear_state_id: string;
  linear_updated_at: string;
  active: number;
}

interface SyncRow {
  last_successful_sync_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

const teamFromRow = (row: TeamRow): LinearTeamMapping => ({
  linearTeamId: row.linear_team_id,
  projectId: row.project_id,
  teamKey: row.team_key,
  teamName: row.team_name,
});

const issueFromRow = (row: IssueRow): LinearIssueMapping => ({
  linearIssueId: row.linear_issue_id,
  taskId: row.task_id,
  linearTeamId: row.linear_team_id,
  identifier: row.identifier,
  url: row.url,
  linearStateId: row.linear_state_id,
  linearUpdatedAt: row.linear_updated_at,
  active: row.active === 1,
});

export function createLinearMappingStore(db: PluginDatabase) {
  const getTeam = db.prepare<[string], TeamRow>(
    "SELECT * FROM linear_team_projects WHERE linear_team_id = ?",
  );
  const getTeamByProject = db.prepare<[string], TeamRow>(
    "SELECT * FROM linear_team_projects WHERE project_id = ?",
  );
  const upsertTeam = db.prepare<[string, string, string, string]>(`
    INSERT INTO linear_team_projects (linear_team_id, project_id, team_key, team_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(linear_team_id) DO UPDATE SET
      project_id = excluded.project_id,
      team_key = excluded.team_key,
      team_name = excluded.team_name
  `);
  const getIssue = db.prepare<[string], IssueRow>(
    "SELECT * FROM linear_issue_tasks WHERE linear_issue_id = ?",
  );
  const getIssueByTask = db.prepare<[string], IssueRow>(
    "SELECT * FROM linear_issue_tasks WHERE task_id = ?",
  );
  const upsertIssue = db.prepare<
    [string, string, string, string, string, string, string, number]
  >(`
    INSERT INTO linear_issue_tasks (
      linear_issue_id, task_id, linear_team_id, identifier, url,
      linear_state_id, linear_updated_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(linear_issue_id) DO UPDATE SET
      task_id = excluded.task_id,
      linear_team_id = excluded.linear_team_id,
      identifier = excluded.identifier,
      url = excluded.url,
      linear_state_id = excluded.linear_state_id,
      linear_updated_at = excluded.linear_updated_at,
      active = excluded.active
  `);
  const setActive = db.prepare<[number, string]>(
    "UPDATE linear_issue_tasks SET active = ? WHERE linear_issue_id = ?",
  );
  const listActive = db.prepare<[], IssueRow>(
    "SELECT * FROM linear_issue_tasks WHERE active = 1 ORDER BY linear_issue_id",
  );
  const getSync = db.prepare<[], SyncRow>(
    "SELECT last_successful_sync_at, last_attempt_at, last_error FROM linear_sync_state WHERE id = 1",
  );
  const updateSync = db.prepare<[string | null, string | null, string | null]>(`
    UPDATE linear_sync_state SET
      last_successful_sync_at = ?, last_attempt_at = ?, last_error = ?
    WHERE id = 1
  `);

  const getTeamMapping = (linearTeamId: string) => {
    const row = getTeam.get(linearTeamId);
    return row ? teamFromRow(row) : undefined;
  };
  const getIssueMapping = (linearIssueId: string) => {
    const row = getIssue.get(linearIssueId);
    return row ? issueFromRow(row) : undefined;
  };

  return {
    getTeamMapping,
    getTeamMappingByProject(projectId: string) {
      const row = getTeamByProject.get(projectId);
      return row ? teamFromRow(row) : undefined;
    },
    upsertTeamMapping(mapping: LinearTeamMapping) {
      upsertTeam.run(
        mapping.linearTeamId,
        mapping.projectId,
        mapping.teamKey,
        mapping.teamName,
      );
      return getTeamMapping(mapping.linearTeamId)!;
    },
    isMappedProject(projectId: string) {
      return getTeamByProject.get(projectId) !== undefined;
    },
    getIssueMapping,
    getIssueMappingByTask(taskId: string) {
      const row = getIssueByTask.get(taskId);
      return row ? issueFromRow(row) : undefined;
    },
    upsertIssueMapping(mapping: LinearIssueMapping) {
      upsertIssue.run(
        mapping.linearIssueId,
        mapping.taskId,
        mapping.linearTeamId,
        mapping.identifier,
        mapping.url,
        mapping.linearStateId,
        mapping.linearUpdatedAt,
        mapping.active ? 1 : 0,
      );
      return getIssueMapping(mapping.linearIssueId)!;
    },
    setIssueActive(linearIssueId: string, active: boolean) {
      setActive.run(active ? 1 : 0, linearIssueId);
      return getIssueMapping(linearIssueId);
    },
    listActiveIssueMappings() {
      return listActive.all().map(issueFromRow);
    },
    getSyncState(): LinearSyncState {
      const row = getSync.get();
      if (!row) throw new Error("Linear sync state is not initialized");
      return {
        lastSuccessfulSyncAt: row.last_successful_sync_at,
        lastAttemptAt: row.last_attempt_at,
        lastError: row.last_error,
      };
    },
    updateSyncState(state: LinearSyncState) {
      updateSync.run(
        state.lastSuccessfulSyncAt,
        state.lastAttemptAt,
        state.lastError,
      );
      return this.getSyncState();
    },
  };
}

export type LinearMappingStore = ReturnType<typeof createLinearMappingStore>;
