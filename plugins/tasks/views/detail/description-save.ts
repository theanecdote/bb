/** Outcome of one save attempt against the updateTask RPC. */
export interface DescriptionSaveOutcome {
  ok: boolean;
  errorMessage?: string;
}

export interface DescriptionSaverOptions {
  save(taskId: string, markdown: string): Promise<DescriptionSaveOutcome>;
  onError(message: string): void;
  /** Timer injection point for tests; returns a cancel function. */
  schedule?(run: () => void, delayMs: number): () => void;
}

export interface DescriptionSaver {
  /** Record a new draft and (re)start the debounce timer. */
  onChange(
    taskId: string,
    markdown: string,
    delayMs: number,
    retryFloorMs?: number,
  ): void;
  /** Flush a draft now, unless a failed write's retry floor is still active. */
  flush(taskId: string): void;
  hasPending(): boolean;
}

/**
 * Debounced description autosave. The pending draft is cleared only once the
 * server has handled the request (success or domain rejection) — a transport
 * failure keeps it pending so the unmount flush or the next debounce tick
 * retries instead of silently dropping the draft.
 */
export function createDescriptionSaver(
  options: DescriptionSaverOptions,
): DescriptionSaver {
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  interface PendingDraft {
    taskId: string;
    markdown: string;
    delayMs: number;
    retryFloorMs?: number;
    cancelTimer?: () => void;
    inFlight: boolean;
    retryNotBefore?: number;
  }
  const pending = new Map<string, PendingDraft>();

  const arm = (draft: PendingDraft, delayMs: number) => {
    draft.cancelTimer?.();
    draft.cancelTimer = schedule(() => {
      draft.cancelTimer = undefined;
      void runSave(draft);
    }, delayMs);
  };

  const runSave = async (draft: PendingDraft) => {
    if (draft.inFlight || pending.get(draft.taskId) !== draft) return;
    const attempt = draft.markdown;
    draft.inFlight = true;
    try {
      const result = await options.save(draft.taskId, attempt);
      // A newer draft may have arrived while the RPC was in flight; only the
      // attempt that was actually sent is settled.
      if (draft.markdown === attempt) pending.delete(draft.taskId);
      if (!result.ok && result.errorMessage !== undefined) {
        options.onError(result.errorMessage);
      }
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      // Mapped writes have a hard minimum interval. Keep the failed draft and
      // its original policy even if the component navigates to another task.
      // Unmapped failures remain pending for an explicit future flush/edit,
      // rather than entering an automatic 800ms retry loop.
      if (draft.retryFloorMs !== undefined) {
        draft.retryNotBefore = Date.now() + draft.retryFloorMs;
        arm(draft, draft.retryFloorMs);
      }
    } finally {
      draft.inFlight = false;
    }
  };

  return {
    onChange(taskId, markdown, delayMs, retryFloorMs) {
      const previous = pending.get(taskId);
      const draft: PendingDraft = previous ?? {
        taskId,
        markdown,
        delayMs,
        inFlight: false,
      };
      draft.markdown = markdown;
      draft.delayMs = delayMs;
      draft.retryFloorMs = retryFloorMs;
      pending.set(taskId, draft);
      const retryDelay = Math.max(0, (draft.retryNotBefore ?? 0) - Date.now());
      arm(draft, Math.max(delayMs, retryDelay));
    },
    flush(taskId) {
      const draft = pending.get(taskId);
      if (draft === undefined) return;
      const retryDelay = (draft.retryNotBefore ?? 0) - Date.now();
      if (retryDelay > 0) {
        arm(draft, retryDelay);
        return;
      }
      draft.cancelTimer?.();
      draft.cancelTimer = undefined;
      void runSave(draft);
    },
    hasPending: () => pending.size > 0,
  };
}
