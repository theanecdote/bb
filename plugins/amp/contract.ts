import { createHash } from "node:crypto";
import { z } from "zod";

export const AmpStateSchema = z.enum([
  "created",
  "running",
  "waiting",
  "idle",
  "failed",
  "cancelled",
  "unknown",
]);

/**
 * Companion-supplied URLs end up in an `href` inside the BB app origin, so
 * only `http:`/`https:` survive. Anything else — `javascript:` above all —
 * is dropped rather than rejected, so one bad URL cannot cost a whole link.
 */
export function sanitizeThreadUrl(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

const ThreadUrlSchema = z
  .string()
  .transform((value) => sanitizeThreadUrl(value))
  .optional();

export const AmpLinkSchema = z.object({
  bbThreadId: z.string(),
  ampThreadId: z.string(),
  runnerId: z.string(),
  targetName: z.string(),
  createdAt: z.string(),
  lastKnownState: AmpStateSchema.optional(),
  threadUrl: ThreadUrlSchema,
});

/** The subset of a target the frontend needs; the rest stays server-side. */
export const TargetViewSchema = z.object({
  name: z.string(),
  runnerId: z.string(),
});

export const TargetSchema = z.object({
  name: z.string().min(1),
  runnerId: z.string().min(1),
  bbHostId: z.string().min(1),
  repoRoot: z.string().min(1),
  repoRemote: z.string().optional(),
  companionClientPath: z.string().regex(/^\/[A-Za-z0-9._/-]+$/),
});

export const PluginConfigSchema = z.object({
  targets: z.array(TargetSchema).default([]),
});

export const StatusSchema = z.object({
  threadId: z.string().optional(),
  state: AmpStateSchema,
  title: z.string().nullable().optional(),
  threadUrl: ThreadUrlSchema,
});

export const TranscriptMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

export const TranscriptPageSchema = z.object({
  messages: z.array(TranscriptMessageSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});

/** BB provider id for threads driven by Amp over ACP. */
export const ACP_AMP_PROVIDER_ID = "acp-amp";

/** Companion links kept per BB thread. Bounded so KV stays small. */
export const MAX_COMPANION_LINKS = 20;

/** Direct ACP children surfaced per BB thread. */
export const MAX_ACP_CHILDREN = 20;

/**
 * A direct BB child thread running the native `acp-amp` provider. BB owns
 * these threads; the plugin only points at them.
 */
export const AcpChildSchema = z.object({
  bbThreadId: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.number(),
});

const AcpChildSourceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  title: z.string().nullable().optional(),
  titleFallback: z.string().nullable().optional(),
  status: z.string().optional(),
  runtime: z.object({ displayStatus: z.string() }).optional(),
  createdAt: z.number().optional(),
  archivedAt: z.number().nullable().optional(),
  deletedAt: z.number().nullable().optional(),
});

export type AmpLink = z.infer<typeof AmpLinkSchema>;
export type AcpChild = z.infer<typeof AcpChildSchema>;
export type Target = z.infer<typeof TargetSchema>;

export function parseConfig(configJson: string | boolean | undefined) {
  if (typeof configJson !== "string") return { targets: [] };
  return PluginConfigSchema.parse(JSON.parse(configJson));
}

export function selectTarget(
  targets: Target[],
  hostId: string,
  repoPath: string,
) {
  const matches = targets.filter(
    (target) => target.bbHostId === hostId && target.repoRoot === repoPath,
  );
  return matches.length === 1 ? matches[0] : null;
}

/** Unparseable timestamps sort oldest, matching the panel's own ordering. */
export function linkTimestamp(link: AmpLink) {
  const parsed = Date.parse(link.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Newest companion link first, one entry per Amp thread, bounded. A link
 * keeps its `createdAt`, so refreshing its status does not move it past a
 * link created at a different time. Ties keep input order (the sort is
 * stable) and `upsertLink` heads the list with the link it wrote, so two
 * runs recorded in the same millisecond order by write recency.
 */
export function orderLinks(links: AmpLink[]) {
  const ordered = [...links].sort(
    (left, right) => linkTimestamp(right) - linkTimestamp(left),
  );
  const seen = new Set<string>();
  const unique: AmpLink[] = [];
  for (const link of ordered) {
    if (seen.has(link.ampThreadId)) continue;
    seen.add(link.ampThreadId);
    unique.push(link);
  }
  return unique.slice(0, MAX_COMPANION_LINKS);
}

/** Replace the entry for one Amp thread, keeping every other link. */
export function upsertLink(links: AmpLink[], next: AmpLink) {
  return orderLinks([
    next,
    ...links.filter((link) => link.ampThreadId !== next.ampThreadId),
  ]);
}

/** Explicit `ampThreadId` selects that link; otherwise the newest one. */
export function selectLink(links: AmpLink[], ampThreadId?: string) {
  const ordered = orderLinks(links);
  if (ampThreadId === undefined) return ordered[0] ?? null;
  return ordered.find((link) => link.ampThreadId === ampThreadId) ?? null;
}

/**
 * Idempotency scope for thread creation. One explicit Send invocation reuses
 * its request id across retries; a new invocation gets its own key so it
 * creates an additional Amp thread instead of colliding with an earlier one.
 * An absent id keeps the pre-multi-link key so in-flight retries still match.
 */
export function pendingCreateKey(threadId: string, invocationId?: string) {
  return invocationId === undefined
    ? `pending-create:${threadId}`
    : `pending-create:${threadId}:${invocationId}`;
}

/**
 * Project BB thread rows onto the native-ACP runs the panel lists. Rows that
 * are not `acp-amp`, archived, or deleted are dropped; unknown row shapes are
 * ignored rather than failing the whole panel.
 */
export function toAcpChildren(rows: unknown[]): AcpChild[] {
  return rows
    .map((row) => AcpChildSourceSchema.safeParse(row))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter(
      (row) =>
        row.providerId === ACP_AMP_PROVIDER_ID &&
        (row.archivedAt ?? null) === null &&
        (row.deletedAt ?? null) === null,
    )
    .map((row) => ({
      bbThreadId: row.id,
      title: row.title?.trim() || row.titleFallback?.trim() || row.id,
      status: row.runtime?.displayStatus ?? row.status ?? "unknown",
      createdAt: row.createdAt ?? 0,
    }))
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        left.bbThreadId.localeCompare(right.bbThreadId),
    )
    .slice(0, MAX_ACP_CHILDREN);
}

export function hashRemote(remote: string) {
  return createHash("sha256").update(remote).digest("hex");
}

export function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

export function parseCompanionPort(value: string | boolean | undefined) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Configure companionPort as a valid TCP port.");
  }
  return port;
}
