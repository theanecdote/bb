import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDescriptionSaver,
  type DescriptionSaveOutcome,
} from "./description-save.js";

const UNMAPPED_DELAY = 800;
const MAPPED_DELAY = 10_000;

function setup(
  save: (taskId: string, markdown: string) => Promise<DescriptionSaveOutcome>,
) {
  const errors: string[] = [];
  const saver = createDescriptionSaver({
    save,
    onError: (message) => errors.push(message),
  });
  return { errors, saver };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createDescriptionSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("uses the current mapping policy across unmapped to mapped navigation", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const { saver } = setup(save);

    saver.onChange("local", "local draft", UNMAPPED_DELAY);
    saver.flush("local"); // task-switch cleanup
    saver.onChange("linear", "mapped draft", MAPPED_DELAY, MAPPED_DELAY);
    await settle();
    expect(save).toHaveBeenCalledWith("local", "local draft");

    await vi.advanceTimersByTimeAsync(9_999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenLastCalledWith("linear", "mapped draft");
  });

  it("flushes the right draft across mapped to mapped navigation", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const { saver } = setup(save);

    saver.onChange("linear-1", "first", MAPPED_DELAY, MAPPED_DELAY);
    saver.flush("linear-1");
    saver.onChange("linear-2", "second", MAPPED_DELAY, MAPPED_DELAY);
    await settle();
    expect(save).toHaveBeenCalledWith("linear-1", "first");
    expect(save).not.toHaveBeenCalledWith("linear-2", expect.anything());
    await vi.advanceTimersByTimeAsync(MAPPED_DELAY);
    expect(save).toHaveBeenLastCalledWith("linear-2", "second");
  });

  it("blur and unmount immediately flush fresh drafts", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const { saver } = setup(save);
    saver.onChange("blurred", "blur draft", MAPPED_DELAY, MAPPED_DELAY);
    saver.flush("blurred");
    saver.onChange("unmounted", "unmount draft", UNMAPPED_DELAY);
    saver.flush("unmounted");
    await settle();
    expect(save.mock.calls).toEqual([
      ["blurred", "blur draft"],
      ["unmounted", "unmount draft"],
    ]);
  });

  it("coalesces ten rapid mapped edits into one write", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const { saver } = setup(save);
    for (let edit = 1; edit <= 10; edit += 1) {
      saver.onChange("linear", `draft ${edit}`, MAPPED_DELAY, MAPPED_DELAY);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(MAPPED_DELAY - 101);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("linear", "draft 10");
  });

  it("does not retry a failed mapped write on blur before its deadline", async () => {
    const save = vi
      .fn<() => Promise<DescriptionSaveOutcome>>()
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "Linear rejected it" },
      })
      .mockResolvedValue({ ok: true });
    const { errors, saver } = setup(save);
    saver.onChange("linear", "draft", MAPPED_DELAY, MAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(MAPPED_DELAY);
    expect(errors).toEqual(["Linear rejected it"]);
    expect(saver.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);
    saver.flush("linear"); // blur
    saver.flush("linear"); // unmount must not bypass the floor either
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries a failed mapped write immediately when flushed at the deadline", async () => {
    const save = vi
      .fn<() => Promise<DescriptionSaveOutcome>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true });
    const { saver } = setup(save);
    saver.onChange("linear", "draft", MAPPED_DELAY, MAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(MAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(MAPPED_DELAY);
    saver.flush("linear");
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.hasPending()).toBe(false);
  });

  it("keeps an unmapped failed draft without an automatic 800ms retry", async () => {
    const save = vi.fn(async () => {
      throw new Error("offline");
    });
    const { saver } = setup(save);
    saver.onChange("local", "draft", UNMAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(UNMAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledOnce();
    expect(saver.hasPending()).toBe(true);
  });

  it("re-arms a newer draft whose timer expires while a save is in flight", async () => {
    let release: (() => void) | undefined;
    const save = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });
    const { saver } = setup(save);
    saver.onChange("task", "v1", UNMAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(UNMAPPED_DELAY);
    saver.onChange("task", "v2", UNMAPPED_DELAY);
    await vi.advanceTimersByTimeAsync(UNMAPPED_DELAY);
    expect(save).toHaveBeenCalledOnce();
    release?.();
    await settle();
    expect(saver.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(UNMAPPED_DELAY - 1);
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
