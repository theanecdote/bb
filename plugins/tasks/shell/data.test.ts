import { describe, expect, it, vi } from "vitest";
import { listAllTasks } from "./data";

describe("listAllTasks", () => {
  it("restarts a concurrent-revision page from the beginning", async () => {
    const first = { id: "first" };
    const replacement = { id: "replacement" };
    const call = vi.fn()
      .mockResolvedValueOnce({ tasks: [first], nextCursor: "old-revision" })
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_cursor" }))
      .mockResolvedValueOnce({ tasks: [replacement], nextCursor: null });
    const tasks = await listAllTasks({ call } as never);
    expect(tasks).toEqual([replacement]);
    expect(call.mock.calls[2]?.[1]).not.toHaveProperty("cursor");
  });

  it("bounds stale-cursor restarts to three attempts", async () => {
    const error = Object.assign(new Error("stale"), { code: "stale_cursor" });
    const call = vi.fn().mockRejectedValue(error);
    await expect(listAllTasks({ call } as never)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(3);
  });
});
