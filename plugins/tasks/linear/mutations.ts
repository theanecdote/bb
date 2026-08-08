import type { Comment, Task, TasksStore, UpdateTaskInput } from "../db";
import type {
  LinearClient,
  LinearIssueUpdate,
  LinearWorkflowState,
} from "./types";
import type { LinearMappingStore } from "./store";
import { LinearApiError } from "./client";

export type TaskMutationOrigin =
  | "user"
  | "cli"
  | "delegation"
  | "agent"
  | "linear-sync";

export class LinearMutationError extends Error {
  constructor(
    readonly code:
      | "linear_write_failed"
      | "linear_rate_limited" = "linear_write_failed",
    message = "Linear rejected the task change. BB was not changed.",
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = "LinearMutationError";
  }
}

export class LinearAttachmentError extends Error {
  readonly code = "mapped_attachment_forbidden" as const;

  constructor() {
    super("Attachments are not supported on tasks imported from Linear");
    this.name = "LinearAttachmentError";
  }
}

const inactiveMappingError = () =>
  new LinearMutationError(
    "linear_write_failed",
    "This task is a read-only historical Linear mapping. Edit the current mapped task instead.",
  );

export interface TaskMutationCommit {
  commit(store: TasksStore): Task;
}

export interface CommentMutationCommit {
  commit(
    store: TasksStore,
    input: Parameters<TasksStore["createComment"]>[0],
  ): Comment;
}

export interface LinearMutationBridge {
  clearWorkflowStateCache(): void;
  prepareTaskMutation(
    current: Task,
    patch: UpdateTaskInput,
    origin: TaskMutationOrigin,
  ): Promise<TaskMutationCommit>;
  prepareUserComment(
    taskId: string,
    body: string,
    origin: TaskMutationOrigin,
  ): Promise<CommentMutationCommit>;
  assertAttachmentAllowed(taskId: string): void;
  isMappedTask(taskId: string): boolean;
  isMappedProject(projectId: string): boolean;
  recordSyncDiagnostic(
    code: "LINEAR_MAPPING_ERROR" | "LINEAR_RATE_LIMITED" | "LINEAR_API_ERROR",
    message: string,
    retryAt?: string,
  ): void;
}

export interface LinearClientSnapshot {
  generation: number;
  client: LinearClient;
}

const priorityToLinear = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 0,
} as const;
const statusType = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  done: "completed",
  canceled: "canceled",
} as const;
const BB_ATTACHMENT_URL =
  /\/api\/v1\/plugins\/[^/]+\/http\/attachments\/download\?/iu;

export function createLinearMutationBridge(deps: {
  client: LinearClient | (() => Promise<LinearClientSnapshot>);
  mappings: LinearMappingStore;
  stateCacheMs?: number;
}): LinearMutationBridge {
  const stateCache = new Map<
    number,
    Map<string, { expiresAt: number; states: LinearWorkflowState[] }>
  >();
  const stateFlights = new Map<
    number,
    Map<string, Promise<LinearWorkflowState[]>>
  >();
  const stateCacheMs = deps.stateCacheMs ?? 5 * 60_000;
  const snapshot = async (): Promise<LinearClientSnapshot> =>
    typeof deps.client === "function"
      ? deps.client()
      : { generation: 0, client: deps.client };

  const statesForTeam = async (
    runtime: LinearClientSnapshot,
    teamId: string,
  ) => {
    const generationCache = stateCache.get(runtime.generation);
    const cached = generationCache?.get(teamId);
    if (cached && cached.expiresAt > Date.now()) return cached.states;
    const generationFlights = stateFlights.get(runtime.generation);
    const existing = generationFlights?.get(teamId);
    if (existing) return existing;
    const flight = runtime.client
      .teamStates(teamId)
      .then((states) => {
        let cache = stateCache.get(runtime.generation);
        if (!cache) stateCache.set(runtime.generation, (cache = new Map()));
        cache.set(teamId, { states, expiresAt: Date.now() + stateCacheMs });
        return states;
      })
      .finally(() => stateFlights.get(runtime.generation)?.delete(teamId));
    let flights = stateFlights.get(runtime.generation);
    if (!flights) stateFlights.set(runtime.generation, (flights = new Map()));
    flights.set(teamId, flight);
    return flight;
  };

  const resolveState = async (
    runtime: LinearClientSnapshot,
    teamId: string,
    status: Task["status"],
  ) => {
    const states = await statesForTeam(runtime, teamId);
    let candidates: LinearWorkflowState[];
    if (status === "in_review") {
      const exact = states.filter(
        (state) => state.name.toLocaleLowerCase() === "in review",
      );
      candidates =
        exact.length > 0
          ? exact
          : states.filter((state) => state.type === "started");
    } else {
      candidates = states.filter((state) => state.type === statusType[status]);
    }
    return [...candidates].sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    )[0]?.id;
  };

  return {
    clearWorkflowStateCache() {
      stateCache.clear();
      stateFlights.clear();
    },
    async prepareTaskMutation(current, patch, origin) {
      const mapping = deps.mappings.getIssueMappingByTask(current.id);
      if (!mapping || origin === "linear-sync") {
        return {
          commit: (store) => store.updateTaskIfChanged(current.id, patch).task,
        };
      }
      if (!mapping.active) throw inactiveMappingError();
      let issue;
      try {
        const runtime = await snapshot();
        const input: LinearIssueUpdate = {};
        const normalizedTitle = patch.title?.trim();
        if (normalizedTitle !== undefined && normalizedTitle !== current.title)
          input.title = normalizedTitle;
        if (
          patch.description !== undefined &&
          patch.description !== current.description
        )
          input.description = patch.description;
        if (patch.priority !== undefined && patch.priority !== current.priority)
          input.priority = priorityToLinear[patch.priority];
        if (patch.dueDate !== undefined && patch.dueDate !== current.dueDate)
          input.dueDate = patch.dueDate;
        if (patch.status !== undefined && patch.status !== current.status) {
          const stateId = await resolveState(
            runtime,
            mapping.linearTeamId,
            patch.status,
          );
          if (!stateId)
            throw new LinearMutationError(
              "linear_write_failed",
              "No compatible Linear workflow state was found",
            );
          input.stateId = stateId;
        }

        if (Object.keys(input).length === 0) {
          return {
            commit: (store) =>
              store.updateTaskIfChanged(current.id, patch).task,
          };
        }
        issue = await runtime.client.updateIssue(mapping.linearIssueId, input);
      } catch (error) {
        if (error instanceof LinearMutationError) throw error;
        if (
          error instanceof LinearApiError &&
          error.code === "LINEAR_RATE_LIMITED"
        )
          throw new LinearMutationError(
            "linear_rate_limited",
            error.message,
            error.retryAt?.toISOString(),
          );
        throw new LinearMutationError();
      }
      return {
        commit(store) {
          const task = store.updateTaskIfChanged(current.id, patch).task;
          deps.mappings.upsertIssueMapping({
            ...mapping,
            linearStateId: issue.state.id,
            linearUpdatedAt: issue.updatedAt,
          });
          return task;
        },
      };
    },
    async prepareUserComment(taskId, body, origin) {
      const mapping = deps.mappings.getIssueMappingByTask(taskId);
      if (mapping && origin !== "linear-sync") {
        if (!mapping.active) throw inactiveMappingError();
        if (BB_ATTACHMENT_URL.test(body)) throw new LinearAttachmentError();
        const runtime = await snapshot();
        try {
          await runtime.client.createComment(mapping.linearIssueId, body);
        } catch (error) {
          if (
            error instanceof LinearApiError &&
            error.code === "LINEAR_RATE_LIMITED"
          )
            throw new LinearMutationError(
              "linear_rate_limited",
              error.message,
              error.retryAt?.toISOString(),
            );
          throw new LinearMutationError(
            "linear_write_failed",
            "Linear rejected the comment. BB was not changed.",
          );
        }
      }
      return { commit: (store, input) => store.createComment(input) };
    },
    assertAttachmentAllowed(taskId) {
      if (deps.mappings.getIssueMappingByTask(taskId))
        throw new LinearAttachmentError();
    },
    isMappedTask: (taskId) =>
      deps.mappings.getIssueMappingByTask(taskId) !== undefined,
    isMappedProject: (projectId) => deps.mappings.isMappedProject(projectId),
    recordSyncDiagnostic(code, message, retryAt) {
      const previous = deps.mappings.getSyncState();
      deps.mappings.updateSyncState({
        ...previous,
        lastError: message,
        lastErrorCode: code,
        retryAt: retryAt ?? previous.retryAt,
      });
    },
  };
}
