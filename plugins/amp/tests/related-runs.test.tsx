// tsx compiles these tests outside the app tsconfig's `include`, so the
// classic JSX runtime is used here and React must be in scope.
import * as React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RelatedRunsList,
  buildRelatedRuns,
  formatRelativeTime,
  statusMeta,
  type AcpChildView,
  type CompanionLinkView,
} from "../related-runs";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

const companion: CompanionLinkView = {
  ampThreadId: "T-companion",
  runnerId: "exe-roster",
  targetName: "Roster Amp",
  createdAt: new Date(NOW - 60_000).toISOString(),
  lastKnownState: "running",
  threadUrl: "https://ampcode.test/threads/T-companion",
};

const acpChild: AcpChildView = {
  bbThreadId: "thr_child",
  title: "Fix the parser",
  status: "active",
  createdAt: NOW - 120_000,
};

function render(
  links: CompanionLinkView[],
  children: AcpChildView[],
  selected: string | null,
) {
  return renderToStaticMarkup(
    <RelatedRunsList
      runs={buildRelatedRuns(links, children)}
      selectedAmpThreadId={selected}
      now={NOW}
      onSelect={() => undefined}
      onOpenThread={() => undefined}
    />,
  );
}

describe("related Amp runs model", () => {
  it("merges companion links and ACP children newest first", () => {
    const runs = buildRelatedRuns([companion], [acpChild]);
    assert.deepEqual(
      runs.map((run) => [run.kind, run.title]),
      [
        ["companion", "T-companion"],
        ["acp", "Fix the parser"],
      ],
    );
  });

  it("maps Amp states and BB display statuses to one vocabulary", () => {
    assert.equal(statusMeta("running").label, "Running");
    assert.equal(statusMeta("active").label, "Active");
    assert.equal(statusMeta("failed").textClassName, "text-destructive");
    assert.equal(statusMeta("error").textClassName, "text-destructive");
    assert.equal(statusMeta("weird").label, "weird");
  });

  it("formats run age against a supplied clock", () => {
    assert.equal(formatRelativeTime(NOW - 30_000, NOW), "just now");
    assert.equal(formatRelativeTime(NOW - 300_000, NOW), "5m ago");
    assert.equal(formatRelativeTime(NOW - 7_200_000, NOW), "2h ago");
    assert.equal(formatRelativeTime(0, NOW), "");
  });
});

describe("related Amp runs list rendering", () => {
  it("labels each run kind and keeps ACP children out of companion actions", () => {
    const markup = render([companion], [acpChild], "T-companion");
    assert.match(markup, /Companion · Roster Amp · 1m ago/);
    assert.match(markup, /Native ACP · 2m ago/);
    assert.match(markup, /data-run-kind="acp"/);
    // The Amp deep link belongs to the companion run only.
    assert.equal(markup.split('aria-label="Open in Amp"').length - 1, 1);
    assert.match(markup, /title="Open Fix the parser in BB"/);
  });

  it("marks the selected companion run and makes ACP row content clickable", () => {
    const markup = render([companion], [acpChild], "T-companion");
    assert.match(markup, /aria-pressed="true"/);
    assert.equal(markup.split('data-selected="true"').length - 1, 1);
    assert.equal(markup.split("aria-pressed").length - 1, 1);
    assert.match(markup, /title="Open Fix the parser in BB"/);
  });

  it("does not mark any run when the selection is elsewhere", () => {
    const markup = render([companion], [acpChild], "T-other");
    assert.match(markup, /aria-pressed="false"/);
    assert.equal(markup.includes('data-selected="true"'), false);
  });

  it("gives icon controls tooltips and accessible labels", () => {
    const markup = render([companion], [acpChild], "T-companion");
    assert.match(markup, /title="Open in Amp" aria-label="Open in Amp"/);
    assert.match(markup, /title="Open Fix the parser in BB"/);
  });

  it("truncates run text instead of letting it overlap", () => {
    const markup = render(
      [{ ...companion, targetName: "A very long Amp target name" }],
      [{ ...acpChild, title: "A very long native ACP child thread title" }],
      null,
    );
    // Three per row: status label, run title, and the meta line.
    assert.equal(markup.split("truncate").length - 1, 6);
  });

  it("renders flat rows with no nested card containers", () => {
    const markup = render([companion], [acpChild], "T-companion");
    assert.equal(markup.split("bg-card").length - 1, 1);
  });

  it("exposes the runs as a list to assistive technology", () => {
    const markup = render([companion], [acpChild], "T-companion");
    assert.match(markup, /role="list" aria-label="Related Amp runs"/);
    assert.equal(markup.split('role="listitem"').length - 1, 2);
  });

  it("clamps and truncates an unrecognized status instead of overlapping", () => {
    const markup = render(
      [{ ...companion, lastKnownState: "a".repeat(80) }],
      [],
      null,
    );
    assert.equal(markup.includes("a".repeat(25)), false);
    assert.match(markup, /overflow-hidden/);
    // Status label, run title, and the meta line all truncate.
    assert.equal(markup.split("truncate").length - 1, 3);
  });

  it("shows an empty state without any run rows", () => {
    const markup = render([], [], null);
    assert.match(markup, /No Amp runs yet\./);
    assert.equal(markup.includes("data-run-kind"), false);
  });
});
