import type { ReactNode } from "react";
import { Icon, type IconName } from "./components/ui/icon";
import { cn } from "./lib/utils";

/**
 * The panel's view model for "related Amp runs". Two kinds share one list:
 *
 * - `companion`: an Amp thread this plugin created through the companion and
 *   tracks in its own KV link list. Selectable, because status, messages,
 *   follow-up, and cancel act on exactly one of them.
 * - `acp`: a direct BB child thread running the native `acp-amp` provider.
 *   BB owns it end to end, so it is only ever navigated to.
 *
 * Both are plain structural types: this module stays free of server imports
 * so it can be rendered and asserted in tests.
 */
export type CompanionLinkView = {
  ampThreadId: string;
  runnerId: string;
  targetName: string;
  createdAt: string;
  lastKnownState?: string;
  threadUrl?: string;
};

export type AcpChildView = {
  bbThreadId: string;
  title: string;
  status: string;
  createdAt: number;
};

export type RelatedRun =
  | {
      kind: "companion";
      key: string;
      title: string;
      status: string;
      createdAt: number;
      ampThreadId: string;
      targetName: string;
      threadUrl: string | null;
    }
  | {
      kind: "acp";
      key: string;
      title: string;
      status: string;
      createdAt: number;
      bbThreadId: string;
    };

export const RUN_KIND_LABELS = {
  companion: "Companion",
  acp: "Native ACP",
} as const;

/** Newest first, with companion runs winning an exact timestamp tie. */
export function buildRelatedRuns(
  links: CompanionLinkView[],
  acpChildren: AcpChildView[],
): RelatedRun[] {
  const runs: RelatedRun[] = [
    ...links.map((link) => ({
      kind: "companion" as const,
      key: `companion:${link.ampThreadId}`,
      title: link.ampThreadId,
      status: link.lastKnownState ?? "unknown",
      createdAt: toTimestamp(link.createdAt),
      ampThreadId: link.ampThreadId,
      targetName: link.targetName,
      threadUrl: link.threadUrl ?? null,
    })),
    ...acpChildren.map((child) => ({
      kind: "acp" as const,
      key: `acp:${child.bbThreadId}`,
      title: child.title,
      status: child.status,
      createdAt: child.createdAt,
      bbThreadId: child.bbThreadId,
    })),
  ];
  return runs.sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      kindRank(left.kind) - kindRank(right.kind) ||
      left.key.localeCompare(right.key),
  );
}

function kindRank(kind: RelatedRun["kind"]) {
  return kind === "companion" ? 0 : 1;
}

function toTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

type StatusMeta = { label: string; dotClassName: string; textClassName: string };

const WORKING: Omit<StatusMeta, "label"> = {
  dotClassName: "bg-success animate-pulse",
  textClassName: "text-success",
};
const PENDING: Omit<StatusMeta, "label"> = {
  dotClassName: "bg-attention animate-pulse",
  textClassName: "text-attention",
};
const ATTENTION: Omit<StatusMeta, "label"> = {
  dotClassName: "bg-attention",
  textClassName: "text-attention",
};
const QUIET: Omit<StatusMeta, "label"> = {
  dotClassName: "bg-muted-foreground",
  textClassName: "text-muted-foreground",
};
const BAD: Omit<StatusMeta, "label"> = {
  dotClassName: "bg-destructive",
  textClassName: "text-destructive",
};

/** Amp companion states and BB display statuses share one status vocabulary. */
const STATUS_META: Record<string, StatusMeta> = {
  created: { label: "Created", ...PENDING },
  running: { label: "Running", ...WORKING },
  waiting: { label: "Waiting", ...ATTENTION },
  idle: { label: "Idle", ...QUIET },
  failed: { label: "Failed", ...BAD },
  cancelled: { label: "Cancelled", ...QUIET },
  unknown: { label: "Unknown", ...QUIET },
  active: { label: "Active", ...WORKING },
  starting: { label: "Starting", ...PENDING },
  provisioning: { label: "Starting", ...PENDING },
  stopping: { label: "Stopping", ...PENDING },
  error: { label: "Error", ...BAD },
  "host-reconnecting": { label: "Reconnecting", ...ATTENTION },
  "waiting-for-host": { label: "Waiting", ...ATTENTION },
};

/** Unknown statuses echo the raw value, bounded so a row cannot be flooded. */
export function statusMeta(status: string): StatusMeta {
  return (
    STATUS_META[status] ?? {
      label: status.length === 0 ? "Unknown" : status.slice(0, 24),
      ...QUIET,
    }
  );
}

export function formatRelativeTime(timestamp: number, now: number) {
  if (timestamp <= 0) return "";
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

export function StatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const meta = statusMeta(status);
  return (
    <span
      title={meta.label}
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-hidden text-xs font-medium",
        meta.textClassName,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", meta.dotClassName)}
      />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

/** Quiet square icon control with a native tooltip and accessible label. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}

export function IconLink({
  icon,
  label,
  href,
}: {
  icon: IconName;
  label: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
    >
      <Icon name={icon} className="size-4" />
    </a>
  );
}

export function RelatedRunRow({
  run,
  selected,
  now,
  onSelect,
  onOpenThread,
}: {
  run: RelatedRun;
  selected: boolean;
  now: number;
  onSelect: (ampThreadId: string) => void;
  onOpenThread: (bbThreadId: string) => void;
}) {
  const age = formatRelativeTime(run.createdAt, now);
  const meta = [
    RUN_KIND_LABELS[run.kind],
    run.kind === "companion" ? run.targetName : null,
    age.length === 0 ? null : age,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <div
      role="listitem"
      data-run-kind={run.kind}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5",
        selected
          ? "border-input bg-state-active"
          : "border-border bg-card hover:bg-state-hover",
      )}
    >
      {run.kind === "companion" ? (
        <button
          type="button"
          aria-pressed={selected}
          title={`Select ${run.ampThreadId}`}
          onClick={() => onSelect(run.ampThreadId)}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 bg-transparent text-left"
        >
          <RunLines run={run} meta={meta} />
        </button>
      ) : (
        <button
          type="button"
          title={`Open ${run.title} in BB`}
          onClick={() => onOpenThread(run.bbThreadId)}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 bg-transparent text-left"
        >
          <RunLines run={run} meta={meta} />
        </button>
      )}
      {run.kind === "companion" && run.threadUrl !== null ? (
        <IconLink icon="ExternalLink" label="Open in Amp" href={run.threadUrl} />
      ) : null}
      {run.kind === "acp" ? (
        <Icon name="ArrowUpRight" className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
    </div>
  );
}

function RunLines({ run, meta }: { run: RelatedRun; meta: string }) {
  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-2">
        {/* Fixed width keeps run titles aligned down the list. */}
        <StatusPill status={run.status} className="w-16" />
        <span className="min-w-0 flex-1 truncate text-sm">{run.title}</span>
      </span>
      <span className="w-full min-w-0 truncate text-xs text-muted-foreground">
        {meta}
      </span>
    </>
  );
}

export function RelatedRunsList({
  runs,
  selectedAmpThreadId,
  now,
  onSelect,
  onOpenThread,
}: {
  runs: RelatedRun[];
  selectedAmpThreadId: string | null;
  now: number;
  onSelect: (ampThreadId: string) => void;
  onOpenThread: (bbThreadId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No Amp runs yet.</p>;
  }
  return (
    <div role="list" aria-label="Related Amp runs" className="flex flex-col gap-1">
      {runs.map((run) => (
        <RelatedRunRow
          key={run.key}
          run={run}
          selected={
            run.kind === "companion" && run.ampThreadId === selectedAmpThreadId
          }
          now={now}
          onSelect={onSelect}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}
