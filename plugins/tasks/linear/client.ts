import { z } from "zod";

import type {
  LinearAssignedSnapshot,
  LinearClient,
  LinearIssue,
  LinearIssueUpdate,
  LinearWorkflowState,
} from "./types";

const API_URL = "https://api.linear.app/graphql";
const MAX_PAGES = 100;
const MAX_ISSUES = 10_000;
const BATCH_SIZE = 50;

const teamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});
const stateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number(),
});
const isoTimestampSchema = z.iso.datetime({ offset: true });
const calendarDateSchema = z.iso.date();
const linearIssueUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "linear.app" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname.split("/").includes("issue")
  );
}, "Expected a canonical Linear issue URL");
const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number().int().min(0).max(4),
  dueDate: calendarDateSchema.nullable(),
  url: linearIssueUrlSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
  assignee: z.object({ id: z.string() }).nullable(),
  team: teamSchema,
  state: stateSchema,
});
const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const graphQLErrorsSchema = z
  .array(
    z
      .object({
        message: z.string().optional(),
        extensions: z
          .object({ code: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  )
  .optional();
const envelopeSchema = z.object({ errors: graphQLErrorsSchema }).passthrough();
const assignedSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string(),
      name: z.string(),
      assignedIssues: z.object({
        nodes: z.array(issueSchema),
        pageInfo: pageInfoSchema,
      }),
    }),
  }),
});
const issuesSchema = z.object({
  data: z.object({ issues: z.object({ nodes: z.array(issueSchema) }) }),
});
const statesSchema = z.object({
  data: z.object({
    workflowStates: z.object({
      nodes: z.array(stateSchema),
      pageInfo: pageInfoSchema,
    }),
  }),
});
const updateSchema = z.object({
  data: z.object({
    issueUpdate: z.object({ success: z.literal(true), issue: issueSchema }),
  }),
});
const commentSchema = z.object({
  data: z.object({
    commentCreate: z.object({
      success: z.literal(true),
      comment: z.object({ id: z.string() }),
    }),
  }),
});

export class LinearApiError extends Error {
  readonly name = "LinearApiError";
  constructor(
    readonly code: "LINEAR_RATE_LIMITED" | "LINEAR_API_ERROR",
    message: string,
    readonly retryAt?: Date,
    readonly rejectedCredentials = false,
  ) {
    super(message);
  }
}

/** Internal control flow only: callers can cancel without recording an API failure. */
export class LinearRequestCanceled extends Error {
  readonly name = "LinearRequestCanceled";
  constructor() {
    super("Linear request canceled");
  }
}

export interface CreateLinearClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const ISSUE_FIELDS = `id identifier title description priority dueDate url updatedAt archivedAt assignee { id } team { id key name } state { id name type position }`;
const QUERIES = {
  ViewerAssignedIssues: `query ViewerAssignedIssues($after: String) { viewer { id name assignedIssues(first: 100, after: $after, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
  IssuesByIds: `query IssuesByIds($ids: [ID!]!, $includeArchived: Boolean!) { issues(first: 50, filter: { id: { in: $ids } }, includeArchived: $includeArchived) { nodes { ${ISSUE_FIELDS} } } }`,
  TeamStates: `query TeamStates($teamId: ID!, $after: String) { workflowStates(first: 100, after: $after, filter: { team: { id: { eq: $teamId } } }) { nodes { id name type position } pageInfo { hasNextPage endCursor } } }`,
  UpdateIssue: `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
  CreateComment: `mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }`,
} as const;

function retryAt(headers: Headers): Date | undefined {
  const candidates: number[] = [];
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const value = Number.isFinite(seconds)
      ? Date.now() + seconds * 1000
      : Date.parse(retry);
    if (Number.isFinite(value)) candidates.push(value);
  }
  for (const name of [
    "x-ratelimit-requests-reset",
    "x-ratelimit-endpoint-requests-reset",
    "x-ratelimit-complexity-reset",
  ]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) candidates.push(value);
  }
  return candidates.length ? new Date(Math.max(...candidates)) : undefined;
}

export function createLinearClient(
  options: CreateLinearClientOptions,
): LinearClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request<T>(
    operationName: keyof typeof QUERIES,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(API_URL, {
        method: "POST",
        headers: {
          Authorization: options.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: QUERIES[operationName],
          operationName,
          variables,
        }),
        signal: controller.signal,
      });
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        if (response.status === 429)
          throw new LinearApiError(
            "LINEAR_RATE_LIMITED",
            "Linear is rate limited. Try again later.",
            retryAt(response.headers),
          );
        if (response.status === 401)
          throw new LinearApiError(
            "LINEAR_API_ERROR",
            "Linear authentication failed.",
            undefined,
            true,
          );
        throw new LinearApiError(
          "LINEAR_API_ERROR",
          "Linear returned an invalid response.",
        );
      }
      const envelope = envelopeSchema.safeParse(json);
      const graphQLErrors = envelope.success
        ? (envelope.data.errors ?? [])
        : [];
      if (
        response.status === 429 ||
        graphQLErrors.some((error) => error.extensions?.code === "RATELIMITED")
      )
        throw new LinearApiError(
          "LINEAR_RATE_LIMITED",
          "Linear is rate limited. Try again later.",
          retryAt(response.headers),
        );
      if (
        response.status === 401 ||
        graphQLErrors.some(
          (error) => error.extensions?.code === "AUTHENTICATION_ERROR",
        )
      )
        throw new LinearApiError(
          "LINEAR_API_ERROR",
          "Linear authentication failed.",
          undefined,
          true,
        );
      if (!response.ok || !envelope.success || graphQLErrors.length > 0)
        throw new LinearApiError(
          "LINEAR_API_ERROR",
          "Linear API request failed.",
        );
      const parsed = schema.safeParse(json);
      if (!parsed.success)
        throw new LinearApiError(
          "LINEAR_API_ERROR",
          "Linear returned an invalid response.",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof LinearApiError) throw error;
      if (signal?.aborted && !timedOut) throw new LinearRequestCanceled();
      throw new LinearApiError(
        "LINEAR_API_ERROR",
        timedOut ? "Linear request timed out." : "Linear API request failed.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    async viewerAssignedIssues(signal) {
      const issues: LinearIssue[] = [];
      let after: string | null = null;
      let viewerId = "";
      let viewerName = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: z.infer<typeof assignedSchema> = await request(
          "ViewerAssignedIssues",
          { after },
          assignedSchema,
          signal,
        );
        viewerId = result.data.viewer.id;
        viewerName = result.data.viewer.name;
        issues.push(...result.data.viewer.assignedIssues.nodes);
        if (issues.length > MAX_ISSUES)
          throw new LinearApiError(
            "LINEAR_API_ERROR",
            "Linear issue result limit exceeded.",
          );
        const info: z.infer<typeof pageInfoSchema> =
          result.data.viewer.assignedIssues.pageInfo;
        if (!info.hasNextPage)
          return {
            viewerId,
            viewerName,
            issues,
          } satisfies LinearAssignedSnapshot;
        if (!info.endCursor)
          throw new LinearApiError(
            "LINEAR_API_ERROR",
            "Linear returned invalid pagination data.",
          );
        after = info.endCursor;
      }
      throw new LinearApiError(
        "LINEAR_API_ERROR",
        "Linear page limit exceeded.",
      );
    },
    async issuesByIds(ids, signal) {
      const issues: LinearIssue[] = [];
      for (let start = 0; start < ids.length; start += BATCH_SIZE) {
        const result = await request(
          "IssuesByIds",
          { ids: ids.slice(start, start + BATCH_SIZE), includeArchived: true },
          issuesSchema,
          signal,
        );
        issues.push(...result.data.issues.nodes);
      }
      return issues;
    },
    async teamStates(teamId, signal) {
      const states: LinearWorkflowState[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: z.infer<typeof statesSchema> = await request(
          "TeamStates",
          { teamId, after },
          statesSchema,
          signal,
        );
        states.push(...result.data.workflowStates.nodes);
        const info: z.infer<typeof pageInfoSchema> =
          result.data.workflowStates.pageInfo;
        if (!info.hasNextPage) return states;
        if (!info.endCursor)
          throw new LinearApiError(
            "LINEAR_API_ERROR",
            "Linear returned invalid pagination data.",
          );
        after = info.endCursor;
      }
      throw new LinearApiError(
        "LINEAR_API_ERROR",
        "Linear page limit exceeded.",
      );
    },
    async updateIssue(id, input, signal) {
      const result = await request(
        "UpdateIssue",
        { id, input: input satisfies LinearIssueUpdate },
        updateSchema,
        signal,
      );
      return result.data.issueUpdate.issue;
    },
    async createComment(issueId, body, signal) {
      const result = await request(
        "CreateComment",
        { issueId, body },
        commentSchema,
        signal,
      );
      return result.data.commentCreate.comment;
    },
  };
}
