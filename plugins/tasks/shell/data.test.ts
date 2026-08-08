import { describe, expect, it, vi } from "vitest";
import { listAllTasks } from "./data";

describe("listAllTasks", () => {
  it("restarts a concurrent-revision page from the beginning", async () => {
    const first = { id: "first" };
    const replacement = { id: "replacement" };
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        tasks: [first],
        nextCursor: "old-revision",
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "stale_cursor", message: "stale" },
      })
      .mockResolvedValueOnce({
        ok: true,
        tasks: [replacement],
        nextCursor: null,
      });
    const tasks = await listAllTasks({ call } as never);
    expect(tasks).toEqual([replacement]);
    expect(call.mock.calls[2]?.[1]).not.toHaveProperty("cursor");
  });

  it("bounds stale-cursor restarts to three attempts", async () => {
    const call = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "stale_cursor", message: "stale" },
    });
    await expect(listAllTasks({ call } as never)).rejects.toThrow(
      "Task list changed too frequently",
    );
    expect(call).toHaveBeenCalledTimes(3);
  });
});
