import type { TasksApiStore } from "../api/index.js";
import type { TaskPriority, TaskStatus } from "../db/types.js";
import {
  DEFAULT_COLOR,
  PROJECT_PREFIX_PATTERN,
} from "../views/manage/shared.js";
import type { LinearMappingStore } from "./store.js";
import type { LinearClient, LinearIssue } from "./types.js";

export type LinearSyncErrorCode =
  | "LINEAR_MAPPING_ERROR"
  | "LINEAR_RATE_LIMITED"
  | "LINEAR_API_ERROR";

export interface LinearSyncStatus {
  syncing: boolean;
  viewerName: string | null;
  activeIssueCount: number;
  retryAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: { code: LinearSyncErrorCode; message: string } | null;
}

export interface LinearSyncResult {
  ok: boolean;
  createdProjects: number;
  createdTasks: number;
  updatedTasks: number;
  deactivatedTasks: number;
  error?: { code: LinearSyncErrorCode; message: string };
}

export interface LinearSyncService {
  sync(): Promise<LinearSyncResult>;
  getStatus(): LinearSyncStatus;
  rejectedCredentials(): boolean;
}

export interface LinearSyncDependencies {
  client: LinearClient;
  mappings: LinearMappingStore;
  store: TasksApiStore;
  publishProjectChanged?: (projectId: string) => void;
  publishTaskChanged?: (taskId: string, projectId: string) => void;
  warn?: (message: string) => void;
  now?: () => Date;
}

class LinearMappingError extends Error {
  readonly code = "LINEAR_MAPPING_ERROR";
}

function priority(value: number): TaskPriority {
  return (
    (["none", "urgent", "high", "medium", "low"] as const)[value] ?? "none"
  );
}

const knownStates: Record<string, TaskStatus> = {
  triage: "todo",
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
  duplicate: "canceled",
};

function issueNumber(issue: LinearIssue): number {
  const match = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/.exec(issue.identifier);
  if (!match || match[1] !== issue.team.key) {
    throw new LinearMappingError(
      `Linear issue identifier ${issue.identifier} cannot be mapped safely`,
    );
  }
  const value = Number(match[2]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new LinearMappingError(
      `Linear issue identifier ${issue.identifier} has an invalid number`,
    );
  return value;
}

function safeError(error: unknown): {
  code: LinearSyncErrorCode;
  message: string;
} {
  if (error instanceof LinearMappingError)
    return { code: error.code, message: error.message };
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "LINEAR_RATE_LIMITED" ||
      (error as { code?: string }).code === "LINEAR_API_ERROR")
  ) {
    const candidate = error as {
      code: "LINEAR_RATE_LIMITED" | "LINEAR_API_ERROR";
      message?: string;
    };
    return {
      code: candidate.code,
      message: candidate.message ?? "Linear synchronization failed",
    };
  }
  return { code: "LINEAR_API_ERROR", message: "Linear synchronization failed" };
}

export function createLinearSyncService(
  deps: LinearSyncDependencies,
): LinearSyncService {
  let flight: Promise<LinearSyncResult> | null = null;
  let syncing = false;
  const warnedStateIds = new Set<string>();
  let volatileError: LinearSyncStatus["lastError"] = null;
  let viewerName: string | null = null;
  let activeIssueCount = 0;
  let rateLimitRetryAt: string | null = null;
  let credentialsRejected = false;
  const now = () => (deps.now ?? (() => new Date()))().toISOString();

  const mapState = (issue: LinearIssue): TaskStatus => {
    const mapped = knownStates[issue.state.type];
    if (mapped) return mapped;
    if (!warnedStateIds.has(issue.state.id)) {
      warnedStateIds.add(issue.state.id);
      deps.warn?.(
        `Unknown Linear workflow state ${issue.state.id}; using backlog`,
      );
    }
    return "backlog";
  };

  function validateSnapshot(issues: readonly LinearIssue[]): void {
    const ids = new Set<string>();
    for (const issue of issues) {
      if (ids.has(issue.id))
        throw new LinearMappingError(
          `Linear returned duplicate issue ${issue.id}`,
        );
      ids.add(issue.id);
      if (!PROJECT_PREFIX_PATTERN.test(issue.team.key))
        throw new LinearMappingError(
          `Linear team key ${issue.team.key} is not a valid Tasks prefix`,
        );
      issueNumber(issue);
    }
    const teams = new Map(issues.map((issue) => [issue.team.id, issue.team]));
    for (const team of teams.values()) {
      const mapped = deps.mappings.getTeamMapping(team.id);
      const conflict = deps.store.tasks
        .listProjects()
        .find(
          (project) =>
            project.prefix.toLowerCase() === team.key.toLowerCase() &&
            project.id !== mapped?.projectId,
        );
      if (conflict)
        throw new LinearMappingError(
          `Tasks project prefix ${team.key} is already in use`,
        );
      if (mapped && !deps.store.tasks.getProject(mapped.projectId))
        throw new LinearMappingError(
          `Mapped Tasks project for Linear team ${team.key} is missing`,
        );
      const mappedProject = mapped
        ? deps.store.tasks.getProject(mapped.projectId)
        : undefined;
      if (mapped && mappedProject && mappedProject.prefix !== mapped.teamKey)
        throw new LinearMappingError(
          `Mapped Tasks project prefix ${mappedProject.prefix} differs from Linear team key ${mapped.teamKey}`,
        );
    }
  }

  async function run(): Promise<LinearSyncResult> {
    const attemptAt = now();
    try {
      // All network work and all validation happen before the first mutation.
      const snapshot = await deps.client.viewerAssignedIssues();
      viewerName = snapshot.viewerName;
      activeIssueCount = snapshot.issues.length;
      validateSnapshot(snapshot.issues);
      const activeIds = new Set(snapshot.issues.map((issue) => issue.id));
      const missing = deps.mappings
        .listActiveIssueMappings()
        .filter((mapping) => !activeIds.has(mapping.linearIssueId));
      const reconciled = missing.length
        ? await deps.client.issuesByIds(
            missing.map((mapping) => mapping.linearIssueId),
          )
        : [];
      const reconciledById = new Map(
        reconciled.map((issue) => [issue.id, issue]),
      );

      const changedProjects: string[] = [];
      const changedTasks = new Map<string, string>();
      let createdProjects = 0,
        createdTasks = 0,
        updatedTasks = 0,
        deactivatedTasks = 0;
      deps.store.transaction(() => {
        const teams = new Map(
          snapshot.issues.map((issue) => [issue.team.id, issue.team]),
        );
        for (const team of teams.values()) {
          let mapping = deps.mappings.getTeamMapping(team.id);
          if (!mapping) {
            const project = deps.store.tasks.createProject({
              name: team.name,
              prefix: team.key,
              color: DEFAULT_COLOR,
            });
            mapping = deps.mappings.upsertTeamMapping({
              linearTeamId: team.id,
              projectId: project.id,
              teamKey: team.key,
              teamName: team.name,
            });
            changedProjects.push(project.id);
            createdProjects++;
          } else if (mapping.teamKey !== team.key) {
            // Prefix changes are deliberately not silently applied; validation guarantees the current key is free.
            throw new LinearMappingError(
              `Linear team ${team.name} changed its key; remapping is required`,
            );
          } else if (mapping.teamName !== team.name) {
            deps.store.tasks.updateProject(mapping.projectId, {
              name: team.name,
            });
            deps.mappings.upsertTeamMapping({
              linearTeamId: team.id,
              projectId: mapping.projectId,
              teamKey: team.key,
              teamName: team.name,
            });
            changedProjects.push(mapping.projectId);
          }
        }

        for (const issue of snapshot.issues) {
          const team = deps.mappings.getTeamMapping(issue.team.id)!;
          let mapping = deps.mappings.getActiveIssueMapping(issue.id);
          if (mapping && mapping.linearTeamId !== issue.team.id) {
            deps.mappings.setIssueMappingActive(mapping.taskId, false);
            mapping = undefined;
          }
          mapping ??= deps.mappings.getIssueMappingForTeam(
            issue.id,
            issue.team.id,
          );
          let task = mapping
            ? deps.store.tasks.getTask(mapping.taskId)
            : undefined;
          if (!task) {
            task = deps.store.tasks.createTask({
              projectId: team.projectId,
              number: issueNumber(issue),
              title: issue.title,
              description: issue.description ?? "",
              status: mapState(issue),
              priority: priority(issue.priority),
              dueDate: issue.dueDate,
            });
            createdTasks++;
            changedTasks.set(task.id, task.projectId);
          } else if (mapping!.linearUpdatedAt !== issue.updatedAt) {
            const update = deps.store.tasks.updateTaskIfChanged(task.id, {
              title: issue.title,
              description: issue.description ?? "",
              priority: priority(issue.priority),
              dueDate: issue.dueDate,
              ...(mapping!.linearStateId === issue.state.id
                ? {}
                : { status: mapState(issue) }),
            });
            if (update.changed) {
              updatedTasks++;
              changedTasks.set(task.id, task.projectId);
            }
          }
          deps.mappings.upsertIssueMapping({
            linearIssueId: issue.id,
            taskId: task.id,
            linearTeamId: issue.team.id,
            identifier: issue.identifier,
            url: issue.url,
            linearStateId: issue.state.id,
            linearUpdatedAt: issue.updatedAt,
            active: true,
          });
        }

        for (const mapping of missing) {
          const issue = reconciledById.get(mapping.linearIssueId);
          const task = deps.store.tasks.getTask(mapping.taskId);
          let terminal: TaskStatus | undefined;
          if (issue?.state.type === "completed") terminal = "done";
          else if (
            issue?.state.type === "canceled" ||
            issue?.state.type === "duplicate"
          )
            terminal = "canceled";
          if (terminal && task) {
            const update = deps.store.tasks.updateTaskIfChanged(task.id, {
              status: terminal,
            });
            if (update.changed) {
              updatedTasks++;
              changedTasks.set(task.id, task.projectId);
            }
          }
          // Missing lookup results are not evidence of deletion. Only an observed archived/unassigned issue is inactive.
          if (
            issue &&
            (terminal !== undefined ||
              issue.archivedAt !== null ||
              issue.assignee?.id !== snapshot.viewerId)
          ) {
            deps.mappings.setIssueMappingActive(mapping.taskId, false);
            deactivatedTasks++;
          }
        }
        deps.mappings.updateSyncState({
          lastAttemptAt: attemptAt,
          lastSuccessfulSyncAt: attemptAt,
          lastError: null,
        });
      });
      volatileError = null;
      credentialsRejected = false;
      rateLimitRetryAt = null;
      for (const id of changedProjects) deps.publishProjectChanged?.(id);
      for (const [taskId, projectId] of changedTasks)
        deps.publishTaskChanged?.(taskId, projectId);
      return {
        ok: true,
        createdProjects,
        createdTasks,
        updatedTasks,
        deactivatedTasks,
      };
    } catch (cause) {
      credentialsRejected =
        typeof cause === "object" &&
        cause !== null &&
        "rejectedCredentials" in cause &&
        cause.rejectedCredentials === true;
      const error = safeError(cause);
      volatileError = error;
      if (
        error.code === "LINEAR_RATE_LIMITED" &&
        typeof cause === "object" &&
        cause !== null &&
        "retryAt" in cause
      ) {
        const retryAt = (cause as { retryAt?: Date }).retryAt;
        rateLimitRetryAt = retryAt?.toISOString() ?? null;
      }
      const previous = deps.mappings.getSyncState();
      deps.store.transaction(() =>
        deps.mappings.updateSyncState({
          ...previous,
          lastAttemptAt: attemptAt,
          lastError: error.message,
        }),
      );
      return {
        ok: false,
        createdProjects: 0,
        createdTasks: 0,
        updatedTasks: 0,
        deactivatedTasks: 0,
        error,
      };
    }
  }

  return {
    sync() {
      if (flight) return flight;
      syncing = true;
      flight = run().finally(() => {
        syncing = false;
        flight = null;
      });
      return flight;
    },
    getStatus() {
      const state = deps.mappings.getSyncState();
      return {
        syncing,
        viewerName,
        activeIssueCount,
        retryAt: rateLimitRetryAt,
        ...state,
        lastError:
          volatileError ??
          (state.lastError
            ? { code: "LINEAR_API_ERROR", message: state.lastError }
            : null),
      };
    },
    rejectedCredentials: () => credentialsRejected,
  };
}
