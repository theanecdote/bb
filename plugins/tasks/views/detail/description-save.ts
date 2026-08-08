/** The relevant portion of the updateTask RPC's typed outcome. */
export type DescriptionSaveOutcome =
  | { ok: true }
  | { ok: false; error: { message: string } };

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
 * server has accepted the request. Mapped domain and transport failures keep
 * the draft pending so a later retry or flush cannot silently drop it.
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
    inFlight?: Promise<void>;
    retryNotBefore?: number;
  }
  const pending = new Map<string, PendingDraft>();

  const arm = (draft: PendingDraft, delayMs: number) => {
    draft.cancelTimer?.();
    draft.cancelTimer = schedule(() => {
      draft.cancelTimer = undefined;
      // Do not let a follow-up timer get consumed by the write ahead of it.
      // Keeping it armed also gives a long-running write another opportunity
      // to settle before the newest draft is sent.
      if (draft.inFlight !== undefined) {
        arm(draft, delayMs);
        return;
      }
      void runSave(draft);
    }, delayMs);
  };

  const runSave = (draft: PendingDraft): Promise<void> => {
    if (pending.get(draft.taskId) !== draft) return Promise.resolve();
    if (draft.inFlight !== undefined) return draft.inFlight;
    const attempt = draft.markdown;
    const inFlight = (async () => {
      try {
        const result = await options.save(draft.taskId, attempt);
        if (result.ok) {
          // A newer draft may have arrived while the RPC was in flight; only the
          // attempt that was actually sent is settled.
          if (draft.markdown === attempt) pending.delete(draft.taskId);
        } else {
          options.onError(result.error.message);
          if (draft.retryFloorMs !== undefined) {
            draft.retryNotBefore = Date.now() + draft.retryFloorMs;
            arm(draft, draft.retryFloorMs);
          } else if (draft.markdown === attempt) {
            // Preserve existing local-task behavior: a handled domain rejection
            // is settled rather than automatically retried.
            pending.delete(draft.taskId);
          }
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
        draft.inFlight = undefined;
        // A newer edit must remain scheduled after every outcome, including
        // when its earlier follow-up timer fired during this attempt.
        if (pending.get(draft.taskId) === draft && draft.markdown !== attempt) {
          const retryDelay = Math.max(
            0,
            (draft.retryNotBefore ?? 0) - Date.now(),
          );
          arm(draft, Math.max(draft.delayMs, retryDelay));
        }
      }
    })();
    draft.inFlight = inFlight;
    return inFlight;
  };

  return {
    onChange(taskId, markdown, delayMs, retryFloorMs) {
      const previous = pending.get(taskId);
      const draft: PendingDraft = previous ?? {
        taskId,
        markdown,
        delayMs,
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
      if (draft.inFlight !== undefined) {
        // Keep the saver and draft reachable through the active write. Cleanup
        // flushes then continue with the newest value once that write settles.
        const inFlight = draft.inFlight;
        void inFlight.then(() => {
          if (pending.get(taskId) !== draft) return;
          const retryDelay = (draft.retryNotBefore ?? 0) - Date.now();
          if (retryDelay > 0) {
            arm(draft, retryDelay);
            return;
          }
          draft.cancelTimer?.();
          draft.cancelTimer = undefined;
          void runSave(draft);
        });
        return;
      }
      void runSave(draft);
    },
    hasPending: () => pending.size > 0,
  };
}
