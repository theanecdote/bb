import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  POLL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  applyRefreshedLink,
  createLoadSequencer,
  isFollowupSubmitKey,
  isLiveState,
  mergeTranscript,
  nextPollDelay,
  type PanelState,
  type TranscriptMessage,
} from "../panel-state";

describe("follow-up keyboard submission", () => {
  it("submits on Command/Ctrl+Enter but not plain Enter or IME composition", () => {
    assert.equal(
      isFollowupSubmitKey({
        key: "Enter",
        metaKey: true,
        ctrlKey: false,
      }),
      true,
    );
    assert.equal(
      isFollowupSubmitKey({
        key: "Enter",
        metaKey: false,
        ctrlKey: true,
      }),
      true,
    );
    assert.equal(
      isFollowupSubmitKey({
        key: "Enter",
        metaKey: false,
        ctrlKey: false,
      }),
      false,
    );
    assert.equal(
      isFollowupSubmitKey({
        key: "Enter",
        metaKey: true,
        ctrlKey: false,
        isComposing: true,
      }),
      false,
    );
  });
});

function message(id: string, text = id): TranscriptMessage {
  return { id, role: "assistant", text };
}

function companionLink(ampThreadId: string, lastKnownState: string) {
  return {
    ampThreadId,
    runnerId: "exe-roster",
    targetName: "Roster Amp",
    createdAt: "2026-08-08T10:00:00.000Z",
    lastKnownState,
  };
}

function panel(overrides: Partial<PanelState> = {}): PanelState {
  return {
    configured: true,
    selectedTarget: { name: "Roster Amp", runnerId: "exe-roster" },
    link: companionLink("T-a", "running"),
    links: [companionLink("T-a", "running"), companionLink("T-b", "idle")],
    acpChildren: [],
    canSend: true,
    reason: null,
    repo: { path: "/repo", branch: "main" },
    ...overrides,
  };
}

describe("panel load sequencing", () => {
  it("lets only the newest load write", () => {
    const loads = createLoadSequencer();
    const first = loads.begin();
    const second = loads.begin();
    assert.equal(loads.isCurrent(first), false);
    assert.equal(loads.isCurrent(second), true);
  });

  it("drops an overtaken load even when it resolves last", async () => {
    const loads = createLoadSequencer();
    const applied: string[] = [];

    // A realtime-triggered load for run A starts first but resolves last;
    // the user's selection of run B must still be what lands.
    const slowA = (async () => {
      const token = loads.begin();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (loads.isCurrent(token)) applied.push("A");
    })();
    const fastB = (async () => {
      const token = loads.begin();
      if (loads.isCurrent(token)) applied.push("B");
    })();

    await Promise.all([slowA, fastB]);
    assert.deepEqual(applied, ["B"]);
  });

  it("lets a poll tick write only while no newer load has begun", () => {
    const loads = createLoadSequencer();
    loads.begin();
    const tick = loads.current();
    assert.equal(loads.isCurrent(tick), true);
    loads.begin();
    assert.equal(loads.isCurrent(tick), false);
  });

  it("cancels everything in flight on unmount", () => {
    const loads = createLoadSequencer();
    const token = loads.begin();
    loads.cancel();
    assert.equal(loads.isCurrent(token), false);
  });
});

describe("transcript merging", () => {
  it("keeps pages pulled in with Load earlier when the poll refreshes", () => {
    const loaded = [message("m1"), message("m2"), message("m3")];
    const merged = mergeTranscript(loaded, {
      messages: [message("m3", "updated"), message("m4")],
      nextOffset: null,
    });
    assert.deepEqual(
      merged.map((entry) => entry.id),
      ["m1", "m2", "m3", "m4"],
    );
    assert.equal(merged[2].text, "updated");
  });

  it("prepends earlier history without duplicating ids", () => {
    const merged = mergeTranscript(
      [message("m3"), message("m4")],
      { messages: [message("m1"), message("m2"), message("m3")], nextOffset: 80 },
      "prepend",
    );
    assert.deepEqual(
      merged.map((entry) => entry.id),
      ["m1", "m2", "m3", "m4"],
    );
  });

  it("leaves state alone for an empty page", () => {
    const existing = [message("m1")];
    assert.deepEqual(
      mergeTranscript(existing, { messages: [], nextOffset: null }),
      existing,
    );
  });
});

describe("refreshed link application", () => {
  it("updates the related-runs row as well as the header", () => {
    const next = applyRefreshedLink(panel(), companionLink("T-a", "failed"));
    assert.equal(next.link?.lastKnownState, "failed");
    assert.equal(
      next.links.find((entry) => entry.ampThreadId === "T-a")?.lastKnownState,
      "failed",
    );
  });

  it("does not retarget the header when another run refreshes", () => {
    const next = applyRefreshedLink(panel(), companionLink("T-b", "failed"));
    assert.equal(next.link?.ampThreadId, "T-a");
    assert.equal(
      next.links.find((entry) => entry.ampThreadId === "T-b")?.lastKnownState,
      "failed",
    );
  });

  it("adds a link the panel has not seen yet", () => {
    const next = applyRefreshedLink(panel(), companionLink("T-new", "running"));
    assert.equal(next.links.length, 3);
    assert.equal(next.links[0].ampThreadId, "T-new");
  });

  it("is a no-op without a link", () => {
    const state = panel();
    assert.equal(applyRefreshedLink(state, null), state);
  });
});

describe("poll pacing", () => {
  it("polls at the base interval while healthy", () => {
    assert.equal(nextPollDelay(0), POLL_INTERVAL_MS);
  });

  it("backs off on consecutive failures and stops at the ceiling", () => {
    assert.equal(nextPollDelay(1), 4000);
    assert.equal(nextPollDelay(2), 8000);
    assert.equal(nextPollDelay(3), 16_000);
    assert.equal(nextPollDelay(50), POLL_MAX_INTERVAL_MS);
  });

  it("polls only live states", () => {
    assert.equal(isLiveState("running"), true);
    assert.equal(isLiveState("created"), true);
    assert.equal(isLiveState("waiting"), true);
    assert.equal(isLiveState("idle"), false);
    assert.equal(isLiveState("failed"), false);
    assert.equal(isLiveState(undefined), false);
  });
});
