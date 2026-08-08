import { z } from "zod";
import {
  AmpLinkSchema,
  orderLinks,
  sanitizeThreadUrl,
  upsertLink,
  type AmpLink,
} from "./contract";

/** The slice of `bb.storage.kv` the link store needs. */
export type LinkStorage = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

/** The list shape this version writes. */
export const LINK_LIST_VERSION = 1;

/** Pre-multi-link key: exactly one companion link per BB thread. */
export function legacyLinkKey(bbThreadId: string) {
  return `link:${bbThreadId}`;
}

export function linkListKey(bbThreadId: string) {
  return `links:${bbThreadId}`;
}

/** Loose envelope: the version is read before any entry is trusted. */
const LinkListEnvelopeSchema = z.object({
  version: z.number(),
  links: z.array(z.unknown()),
});

export type LinkRecord = {
  links: AmpLink[];
  /**
   * False when the stored row came from a newer plugin version. Its entries
   * are still shown where they parse, but writing would discard fields this
   * version cannot represent, so writes are refused instead.
   */
  writable: boolean;
};

function sanitizeLink(link: AmpLink): AmpLink {
  const threadUrl = sanitizeThreadUrl(link.threadUrl);
  if (threadUrl !== undefined) return { ...link, threadUrl };
  // Drop the key rather than storing an explicit undefined.
  const { threadUrl: _rejected, ...rest } = link;
  return rest;
}

/** Entries are parsed one by one, so one bad row costs only that row. */
function parseLinks(rows: unknown[]) {
  return rows
    .map((row) => AmpLinkSchema.safeParse(row))
    .flatMap((parsed) => (parsed.success ? [sanitizeLink(parsed.data)] : []));
}

/**
 * Read the companion links for a BB thread.
 *
 * The list key wins once it exists. Otherwise the legacy single-link key is
 * adopted as a one-entry list, so threads linked before this version keep
 * working without a migration pass. The legacy row is left in place; it is
 * never read again once a list has been written.
 */
export async function readLinkRecord(
  kv: LinkStorage,
  bbThreadId: string,
): Promise<LinkRecord> {
  const stored = LinkListEnvelopeSchema.safeParse(
    await kv.get(linkListKey(bbThreadId)),
  );
  if (stored.success) {
    return {
      links: orderLinks(parseLinks(stored.data.links)),
      writable: stored.data.version <= LINK_LIST_VERSION,
    };
  }
  const legacy = AmpLinkSchema.safeParse(await kv.get(legacyLinkKey(bbThreadId)));
  return {
    links: legacy.success ? [sanitizeLink(legacy.data)] : [],
    writable: true,
  };
}

export async function readLinks(kv: LinkStorage, bbThreadId: string) {
  return (await readLinkRecord(kv, bbThreadId)).links;
}

/**
 * Serialize read-modify-write per BB thread. Sends, follow-ups, status
 * refreshes, and cancels all rewrite the same row, and an interleaved
 * read-then-write would drop whichever link was added in between.
 */
const writeChains = new Map<string, Promise<unknown>>();

function withThreadWriteLock<T>(bbThreadId: string, run: () => Promise<T>) {
  const previous = writeChains.get(bbThreadId) ?? Promise.resolve();
  // Both arms run `run`, so one failed write does not wedge the chain.
  const result = previous.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(bbThreadId, settled);
  void settled.then(() => {
    // Drop the entry once this write was the last one queued.
    if (writeChains.get(bbThreadId) === settled) writeChains.delete(bbThreadId);
  });
  return result;
}

/** Add or refresh one link without disturbing the thread's other links. */
export async function saveLink(kv: LinkStorage, link: AmpLink) {
  return withThreadWriteLock(link.bbThreadId, async () => {
    const record = await readLinkRecord(kv, link.bbThreadId);
    if (!record.writable) {
      throw new Error(
        "This BB thread's Amp links were written by a newer version of the Amp plugin.",
      );
    }
    const links = upsertLink(record.links, sanitizeLink(link));
    await kv.set(linkListKey(link.bbThreadId), {
      version: LINK_LIST_VERSION,
      links,
    });
    return links;
  });
}
