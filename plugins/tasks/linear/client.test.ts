import { describe, expect, it, vi } from "vitest";

import {
  createLinearClient,
  LinearApiError,
  LinearRequestCanceled,
} from "./client";

const issue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix it",
  description: null,
  priority: 2,
  dueDate: null,
  url: "https://linear.app/acme/issue/ENG-1",
  updatedAt: "2026-08-08T00:00:00.000Z",
  archivedAt: null,
  assignee: { id: "viewer-1" },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  state: { id: "state-1", name: "Started", type: "started", position: 1 },
};

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function assignedPage(
  nodes = [issue],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      viewer: {
        id: "viewer-1",
        name: "Viewer",
        assignedIssues: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

describe("Linear GraphQL client", () => {
  it("sends a personal key, JSON, operation names, and variables", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "lin_api_secret",
      );
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        "application/json",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operationName: "ViewerAssignedIssues",
        variables: { after: null },
      });
      return response(assignedPage());
    });
    await createLinearClient({
      apiKey: "lin_api_secret",
      fetch,
    }).viewerAssignedIssues();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.anything(),
    );
  });

  it.each([
    [401, "LINEAR_API_ERROR"],
    [500, "LINEAR_API_ERROR"],
  ] as const)("maps HTTP %i to a safe error", async (status, code) => {
    const client = createLinearClient({
      apiKey: "lin_api_secret",
      fetch: async () => response({ variables: "secret-variable" }, status),
    });
    const error = await client
      .viewerAssignedIssues()
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("lin_api_secret");
    expect(String(error)).not.toContain("secret-variable");
  });

  it("parses rate limit retry headers", async () => {
    const now = Date.now();
    const client = createLinearClient({
      apiKey: "secret",
      fetch: async () =>
        response({ errors: [{ extensions: { code: "RATELIMITED" } }] }, 400, {
          "Retry-After": "2",
          "X-RateLimit-Requests-Reset": String(now + 10_000),
          "X-RateLimit-Endpoint-Requests-Reset": String(now + 20_000),
          "X-RateLimit-Complexity-Reset": String(now + 15_000),
        }),
    });
    const error = await client
      .viewerAssignedIssues()
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "LINEAR_RATE_LIMITED" });
    expect((error as LinearApiError).retryAt?.getTime()).toBeGreaterThanOrEqual(
      now + 19_000,
    );
  });

  it("classifies documented GraphQL authentication failures internally", async () => {
    const client = createLinearClient({
      apiKey: "secret",
      fetch: async () =>
        response(
          {
            errors: [
              {
                message: "unsafe detail",
                extensions: { code: "AUTHENTICATION_ERROR" },
              },
            ],
          },
          400,
        ),
    });
    const error = await client
      .viewerAssignedIssues()
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "LINEAR_API_ERROR",
      rejectedCredentials: true,
    });
    expect(String(error)).not.toContain("unsafe detail");
  });

  it("safely classifies an HTTP 429 with a non-JSON body", async () => {
    const client = createLinearClient({
      apiKey: "secret",
      fetch: async () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
    });
    await expect(client.viewerAssignedIssues()).rejects.toMatchObject({
      code: "LINEAR_RATE_LIMITED",
    });
  });

  it.each([
    ["malformed JSON", async () => new Response("not-json")],
    [
      "GraphQL errors",
      async () => response({ errors: [{ message: "variable-secret" }] }),
    ],
    [
      "data plus GraphQL errors",
      async () =>
        response({
          ...assignedPage(),
          errors: [{ message: "variable-secret" }],
        }),
    ],
    [
      "invalid response schema",
      async () => response({ data: { viewer: null } }),
    ],
  ])("rejects %s without exposing server details", async (_name, fetch) => {
    const error = await createLinearClient({ apiKey: "key", fetch })
      .viewerAssignedIssues()
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "LINEAR_API_ERROR" });
    expect(String(error)).not.toContain("variable-secret");
  });

  it("aborts after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const pending = createLinearClient({
      apiKey: "key",
      fetch,
      timeoutMs: 10_000,
    }).viewerAssignedIssues();
    const assertion = expect(pending).rejects.toMatchObject({
      code: "LINEAR_API_ERROR",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it("distinguishes caller cancellation from a timeout", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("remote detail")),
            { once: true },
          );
        }),
    );
    const pending = createLinearClient({
      apiKey: "key",
      fetch,
    }).viewerAssignedIssues(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(LinearRequestCanceled);
  });

  it.each([
    ["fractional priority", { priority: 2.5 }],
    ["unsupported priority", { priority: 5 }],
    ["invalid calendar due date", { dueDate: "2026-02-30" }],
    ["non-ISO update timestamp", { updatedAt: "yesterday" }],
    [
      "noncanonical issue port",
      { url: "https://linear.app:444/acme/issue/ENG-1" },
    ],
  ])("rejects %s at the issue boundary", async (_name, patch) => {
    const client = createLinearClient({
      apiKey: "key",
      fetch: async () => response(assignedPage([{ ...issue, ...patch }])),
    });
    await expect(client.viewerAssignedIssues()).rejects.toMatchObject({
      code: "LINEAR_API_ERROR",
    });
  });

  it("accepts documented nullable dates and offset ISO timestamps", async () => {
    const client = createLinearClient({
      apiKey: "key",
      fetch: async () =>
        response(
          assignedPage([
            {
              ...issue,
              dueDate: "2026-02-28",
              updatedAt: "2026-08-08T01:00:00+01:00",
              archivedAt: null,
            },
          ]),
        ),
    });
    await expect(client.viewerAssignedIssues()).resolves.toMatchObject({
      issues: [{ priority: 2, dueDate: "2026-02-28" }],
    });
  });

  it("follows Relay pages", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { after: string | null };
      };
      return response(
        variables.after === null
          ? assignedPage([issue], true, "next")
          : assignedPage([{ ...issue, id: "issue-2" }]),
      );
    });
    const snapshot = await createLinearClient({
      apiKey: "key",
      fetch,
    }).viewerAssignedIssues();
    expect(snapshot.issues.map(({ id }) => id)).toEqual(["issue-1", "issue-2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation to every pagination and batch request", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      calls++;
      if (calls === 1) return response(assignedPage([issue], true, "next"));
      expect(init?.signal?.aborted).toBe(false);
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      });
      throw new Error("unreachable");
    });
    await expect(
      createLinearClient({ apiKey: "key", fetch }).viewerAssignedIssues(
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(LinearRequestCanceled);
    expect(fetch).toHaveBeenCalledTimes(2);

    const alreadyAborted = AbortSignal.abort();
    const batchFetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(new Error("aborted"));
    });
    await expect(
      createLinearClient({ apiKey: "key", fetch: batchFetch }).issuesByIds(
        Array.from({ length: 51 }, (_, index) => String(index)),
        alreadyAborted,
      ),
    ).rejects.toBeInstanceOf(LinearRequestCanceled);
    expect(batchFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects more than 100 pages and more than 10,000 issues", async () => {
    let page = 0;
    const endless = createLinearClient({
      apiKey: "key",
      fetch: async () => response(assignedPage([], true, String(++page))),
    });
    await expect(endless.viewerAssignedIssues()).rejects.toMatchObject({
      code: "LINEAR_API_ERROR",
    });
    const tooMany = createLinearClient({
      apiKey: "key",
      fetch: async () =>
        response(
          assignedPage(
            Array.from({ length: 10_001 }, (_, i) => ({
              ...issue,
              id: `i-${i}`,
            })),
          ),
        ),
    });
    await expect(tooMany.viewerAssignedIssues()).rejects.toMatchObject({
      code: "LINEAR_API_ERROR",
    });
  });

  it("batches issue IDs by 50 and includes archived issues", async () => {
    const sizes: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        operationName: string;
        variables: { ids: string[]; includeArchived: boolean };
      };
      expect(body.operationName).toBe("IssuesByIds");
      expect(body.variables.includeArchived).toBe(true);
      sizes.push(body.variables.ids.length);
      return response({
        data: {
          issues: { nodes: body.variables.ids.map((id) => ({ ...issue, id })) },
        },
      });
    });
    const result = await createLinearClient({
      apiKey: "key",
      fetch,
    }).issuesByIds(Array.from({ length: 121 }, (_, i) => `i-${i}`));
    expect(sizes).toEqual([50, 50, 21]);
    expect(result).toHaveLength(121);
  });
});
