import type { AcpChildView, CompanionLinkView } from "./related-runs";

/**
 * The panel's non-visual behavior: which async result is still allowed to
 * land, how a poll merges into loaded history, and how fast to poll. Kept
 * out of the component so the race and backoff rules can be asserted.
 */

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type TranscriptPage = {
  messages: TranscriptMessage[];
  nextOffset: number | null;
};

export type PanelState = {
  configured: boolean;
  selectedTarget: { runnerId: string; name: string } | null;
  link: CompanionLinkView | null;
  links: CompanionLinkView[];
  acpChildren: AcpChildView[];
  canSend: boolean;
  reason: string | null;
  repo: { path: string; branch: string | null } | null;
};

/**
 * Hands out a token per load and reports whether it is still the newest.
 *
 * Loads overlap: mount, realtime signals, and selection changes all trigger
 * one, each with two awaits. Without this an older load's panel state could
 * land next to a newer load's transcript, and the follow-up composer would
 * then target a run the user is not reading.
 */
export function createLoadSequencer() {
  let issued = 0;
  return {
    begin() {
      issued += 1;
      return issued;
    },
    /**
     * Observe the current token without starting a load. Polling uses this:
     * a tick may write only while no newer load has begun, but a tick must
     * not itself invalidate a load the user just triggered.
     */
    current() {
      return issued;
    },
    isCurrent(token: number) {
      return token === issued;
    },
    /** Invalidate everything in flight without starting a load. */
    cancel() {
      issued += 1;
    },
  };
}

/**
 * Fold a freshly fetched page into the messages already on screen.
 *
 * The poll refetches offset 0, so replacing state outright would throw away
 * pages the user pulled in with "Load earlier". Ids in the new page win, and
 * everything else keeps its position.
 */
export function mergeTranscript(
  existing: TranscriptMessage[],
  page: TranscriptPage,
  mode: "refresh" | "prepend" = "refresh",
) {
  const incoming = page.messages;
  const incomingIds = new Set(incoming.map((message) => message.id));
  const kept = existing.filter((message) => !incomingIds.has(message.id));
  return mode === "prepend" ? [...incoming, ...kept] : [...kept, ...incoming];
}

/**
 * Keep the related-runs list in step with a refreshed link, so a row's
 * status cannot sit at "Running" after the header says the run finished.
 */
export function applyRefreshedLink(
  state: PanelState,
  link: CompanionLinkView | null | undefined,
): PanelState {
  if (link === null || link === undefined) return state;
  const links = state.links.some(
    (entry) => entry.ampThreadId === link.ampThreadId,
  )
    ? state.links.map((entry) =>
        entry.ampThreadId === link.ampThreadId ? link : entry,
      )
    : [link, ...state.links];
  return {
    ...state,
    links,
    link:
      state.link?.ampThreadId === link.ampThreadId || state.link === null
        ? link
        : state.link,
  };
}

export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_INTERVAL_MS = 30_000;

/**
 * Every companion call spawns a terminal on the enrolled host, so a wedged
 * companion must not be polled at full rate. Successes stay at the base
 * interval; consecutive failures back off exponentially to 30s.
 */
export function nextPollDelay(consecutiveErrors: number) {
  if (consecutiveErrors <= 0) return POLL_INTERVAL_MS;
  return Math.min(
    POLL_MAX_INTERVAL_MS,
    POLL_INTERVAL_MS * 2 ** Math.min(consecutiveErrors, 10),
  );
}

const LIVE_STATES = ["created", "running", "waiting"];

export function isLiveState(state: string | undefined) {
  return state !== undefined && LIVE_STATES.includes(state);
}

export function isFollowupSubmitKey(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
}) {
  return (
    input.key === "Enter" &&
    (input.metaKey || input.ctrlKey) &&
    input.isComposing !== true
  );
}
