import { expect, it } from "vitest";

const apiKey = process.env.LINEAR_SMOKE_API_KEY;

it.skipIf(!apiKey)(
  "reads the Linear viewer and one page of active assigned issues",
  async () => {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: apiKey!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operationName: "LinearReadOnlySmoke",
        query: `query LinearReadOnlySmoke {
          viewer {
            id
            assignedIssues(
              first: 100
              filter: { state: { type: { nin: ["completed", "canceled"] } } }
            ) {
              nodes { id identifier }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        variables: {},
      }),
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.ok).toBe(true);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      data: {
        viewer: {
          id: expect.any(String),
          assignedIssues: {
            nodes: expect.any(Array),
            pageInfo: {
              hasNextPage: expect.any(Boolean),
              endCursor: expect.toSatisfy(
                (value: unknown) => value === null || typeof value === "string",
              ),
            },
          },
        },
      },
    });
  },
  15_000,
);
