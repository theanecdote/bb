import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AcpChildSchema,
  AmpLinkSchema,
  AmpStateSchema,
  StatusSchema,
  TargetSchema,
  TranscriptPageSchema,
  TargetViewSchema,
  hashRemote,
  parseCompanionPort,
  parseConfig,
  sanitizeThreadUrl,
  selectLink,
  selectTarget,
  toAcpChildren,
  truncate,
  type AmpLink,
  type Target,
} from "./contract";
import { readLinks, saveLink } from "./links";
import {
  claimPendingCreate,
  completePendingCreate,
  prunePendingCreates,
} from "./pending";
import { requestThroughHost } from "./host-client";

const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const rpcContract = defineRpcContract({
  getPanelState: {
    input: z
      .object({ threadId: z.string(), ampThreadId: z.string().optional() })
      .strict(),
    output: z.object({
      configured: z.boolean(),
      selectedTarget: TargetViewSchema.nullable(),
      link: AmpLinkSchema.nullable(),
      links: z.array(AmpLinkSchema),
      acpChildren: z.array(AcpChildSchema),
      canSend: z.boolean(),
      reason: z.string().nullable(),
      managedWorktree: z.boolean(),
      dirty: z.boolean(),
      repo: z
        .object({
          path: z.string(),
          branch: z.string().nullable(),
          head: z.string().nullable(),
          remoteHash: z.string().nullable(),
        })
        .nullable(),
    }),
  },
  sendToAmp: {
    input: z
      .object({
        threadId: z.string(),
        targetName: z.string().optional(),
        mode: z.enum(["low", "medium", "high", "ultra"]).default("high"),
        /** Stable per explicit Send; retries of it reuse one Amp thread. */
        invocationId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: z.object({ link: AmpLinkSchema, links: z.array(AmpLinkSchema) }),
  },
  sendFollowup: {
    input: z
      .object({
        threadId: z.string(),
        ampThreadId: z.string().optional(),
        message: z.string().min(1).max(12000),
      })
      .strict(),
    output: z.object({ state: AmpStateSchema }),
  },
  refreshStatus: {
    input: z
      .object({ threadId: z.string(), ampThreadId: z.string().optional() })
      .strict(),
    output: z.object({
      link: AmpLinkSchema.nullable(),
      status: StatusSchema.nullable(),
    }),
  },
  getRunSnapshot: {
    input: z
      .object({
        threadId: z.string(),
        ampThreadId: z.string().optional(),
        offset: z.number().int().nonnegative().max(10_000).default(0),
      })
      .strict(),
    output: z.object({
      link: AmpLinkSchema.nullable(),
      status: StatusSchema.nullable(),
      page: TranscriptPageSchema.nullable(),
    }),
  },
  getMessages: {
    input: z
      .object({
        threadId: z.string(),
        ampThreadId: z.string().optional(),
        offset: z.number().int().nonnegative().max(10_000).default(0),
      })
      .strict(),
    output: TranscriptPageSchema,
  },
  cancelAmp: {
    input: z
      .object({ threadId: z.string(), ampThreadId: z.string().optional() })
      .strict(),
    output: z.object({ state: AmpStateSchema }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    configJson: {
      type: "string",
      label: "Amp target mappings JSON",
      default: JSON.stringify({ targets: [] }, null, 2),
    },
    companionPort: {
      type: "string",
      label: "Companion loopback port",
      default: "43931",
    },
    companionSecret: {
      type: "string",
      label: "Companion secret",
      secret: true,
    },
  });

  bb.rpc.register(rpcContract, {
    async getPanelState({ threadId, ampThreadId }) {
      const ctx = await resolveContext(bb, settings, threadId);
      const target = selectTarget(
        ctx.targets,
        ctx.environment.hostId,
        ctx.repoPath,
      );
      const links = await readLinks(bb.storage.kv, threadId);
      const reason = await sendBlockReason(ctx, target);
      return {
        configured: ctx.targets.length > 0,
        // Only the display fields: host ids, checkout paths, the companion
        // client path, and the unhashed remote stay server-side.
        selectedTarget:
          target === null
            ? null
            : { name: target.name, runnerId: target.runnerId },
        // A stale selection (link dropped from the bounded list) falls back
        // to the newest link instead of leaving the panel with nothing.
        link: selectLink(links, ampThreadId) ?? selectLink(links),
        links,
        acpChildren: await listAcpChildren(bb, threadId),
        canSend: reason === null,
        reason,
        managedWorktree:
          ctx.environment.workspaceProvisionType === "managed-worktree",
        dirty: ctx.dirty,
        repo: ctx.repo,
      };
    },
    /**
     * One round-trip for the panel's poll: status and the latest transcript
     * page for the same link, so the header and the transcript cannot
     * describe different runs.
     */
    async getRunSnapshot({ threadId, ampThreadId, offset }) {
      const links = await readLinks(bb.storage.kv, threadId);
      const link = selectLink(links, ampThreadId);
      if (link === null) return { link: null, status: null, page: null };
      const target = await requireLinkTarget(settings, link);
      const status = StatusSchema.parse(
        await companionRequest(
          bb,
          settings,
          target,
          "GET",
          `/v1/threads/${encodeURIComponent(link.ampThreadId)}`,
        ),
      );
      const nextLink = {
        ...link,
        lastKnownState: status.state,
        threadUrl: status.threadUrl ?? link.threadUrl,
      };
      await saveLink(bb.storage.kv, nextLink);
      const page = TranscriptPageSchema.parse(
        await companionRequest(
          bb,
          settings,
          target,
          "GET",
          `/v1/threads/${encodeURIComponent(link.ampThreadId)}/messages?offset=${offset}`,
        ),
      );
      return { link: nextLink, status, page };
    },
    async sendToAmp({ threadId, targetName, mode, invocationId }) {
      const ctx = await resolveContext(bb, settings, threadId);
      const target =
        targetName === undefined
          ? selectTarget(ctx.targets, ctx.environment.hostId, ctx.repoPath)
          : (ctx.targets.find((candidate) => candidate.name === targetName) ??
            null);
      const reason = await sendBlockReason(ctx, target);
      if (reason !== null || target === null)
        throw new Error(reason ?? "No Amp target selected.");

      const now = Date.now();
      await prunePendingCreates(bb.storage.kv, threadId, now);
      const pending = await claimPendingCreate(
        bb.storage.kv,
        threadId,
        invocationId,
        randomUUID(),
        now,
      );
      if (pending.completedAmpThreadId !== undefined) {
        // This invocation already created a thread; a retry after a lost
        // response must return that run rather than create a second one.
        const links = await readLinks(bb.storage.kv, threadId);
        const existing = selectLink(links, pending.completedAmpThreadId);
        if (existing !== null) return { link: existing, links };
      }

      const packet = await buildHandoffPacket(bb, threadId, ctx, target);
      const response = await companionRequest(
        bb,
        settings,
        target,
        "POST",
        "/v1/threads",
        {
          requestId: pending.requestId,
          runnerId: target.runnerId,
          mode,
          message: packet,
          metadata: {
            bbThreadId: threadId,
            repo: ctx.project.name,
          },
        },
      );

      const parsed = z
        .object({
          threadId: z.string(),
          state: AmpStateSchema,
          threadUrl: z.string().optional(),
        })
        .parse(response);
      const link: AmpLink = {
        bbThreadId: threadId,
        ampThreadId: parsed.threadId,
        runnerId: target.runnerId,
        targetName: target.name,
        createdAt: new Date().toISOString(),
        lastKnownState: parsed.state,
        threadUrl: sanitizeThreadUrl(parsed.threadUrl),
      };
      const links = await saveLink(bb.storage.kv, link);
      // Kept, not deleted: the record must outlive success for the full
      // window so a replayed invocation resolves to this same thread.
      await completePendingCreate(
        bb.storage.kv,
        threadId,
        invocationId,
        pending,
        link.ampThreadId,
      );
      bb.realtime.publish(`amp:${threadId}`, { type: "link-updated" });
      return { link, links };
    },
    async sendFollowup({ threadId, ampThreadId, message }) {
      const link = await requireLink(bb, threadId, ampThreadId);
      const target = await requireLinkTarget(settings, link);
      const response = await companionRequest(
        bb,
        settings,
        target,
        "POST",
        `/v1/threads/${encodeURIComponent(link.ampThreadId)}/messages`,
        { message },
      );
      const parsed = StatusSchema.parse(response);
      await saveLink(bb.storage.kv, {
        ...link,
        lastKnownState: parsed.state,
        threadUrl: parsed.threadUrl ?? link.threadUrl,
      });
      bb.realtime.publish(`amp:${threadId}`, { type: "link-updated" });
      return { state: parsed.state };
    },
    async refreshStatus({ threadId, ampThreadId }) {
      const link = selectLink(
        await readLinks(bb.storage.kv, threadId),
        ampThreadId,
      );
      if (link === null) return { link: null, status: null };
      const target = await requireLinkTarget(settings, link);
      const status = StatusSchema.parse(
        await companionRequest(
          bb,
          settings,
          target,
          "GET",
          `/v1/threads/${encodeURIComponent(link.ampThreadId)}`,
        ),
      );
      const nextLink = {
        ...link,
        lastKnownState: status.state,
        threadUrl: status.threadUrl ?? link.threadUrl,
      };
      await saveLink(bb.storage.kv, nextLink);
      return { link: nextLink, status };
    },
    async cancelAmp({ threadId, ampThreadId }) {
      const link = await requireLink(bb, threadId, ampThreadId);
      const target = await requireLinkTarget(settings, link);
      const status = StatusSchema.parse(
        await companionRequest(
          bb,
          settings,
          target,
          "POST",
          `/v1/threads/${encodeURIComponent(link.ampThreadId)}/cancel`,
          {},
        ),
      );
      await saveLink(bb.storage.kv, { ...link, lastKnownState: status.state });
      bb.realtime.publish(`amp:${threadId}`, { type: "link-updated" });
      return { state: status.state };
    },
    async getMessages({ threadId, ampThreadId, offset }) {
      const link = await requireLink(bb, threadId, ampThreadId);
      const target = await requireLinkTarget(settings, link);
      return TranscriptPageSchema.parse(
        await companionRequest(
          bb,
          settings,
          target,
          "GET",
          `/v1/threads/${encodeURIComponent(link.ampThreadId)}/messages?offset=${offset}`,
        ),
      );
    },
  });
}

async function resolveContext(
  bb: BbPluginApi,
  settings: ReturnType<BbPluginApi["settings"]["define"]>,
  threadId: string,
) {
  const values = await settings.get();
  const config = parseConfig(values.configJson);
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null)
    throw new Error("This BB thread has no environment.");
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (environment.path === null)
    throw new Error("This BB environment has no checkout path.");
  const project = await bb.sdk.projects.get({ projectId: thread.projectId });
  const repoPath = environment.path;
  const repo = await repoFacts(
    bb,
    thread.environmentId,
    repoPath,
    project.gitRemoteUrl,
  );
  return {
    values,
    targets: config.targets,
    thread,
    environment,
    project,
    repoPath,
    repo,
    dirty: repo.dirty,
  };
}

/**
 * Existing links never block a send: an explicit Send to Amp may start an
 * additional companion thread alongside the ones already linked here.
 */
async function sendBlockReason(
  ctx: Awaited<ReturnType<typeof resolveContext>>,
  target: Target | null,
) {
  if (ctx.targets.length === 0) return "No Amp target mappings are configured.";
  if (target === null)
    return "No single Amp target matches this BB host and canonical repo path.";
  if (ctx.repo.unavailable !== null) return ctx.repo.unavailable;
  if (
    target.repoRemote !== undefined &&
    ctx.repo.remoteHash !== hashRemote(target.repoRemote)
  ) {
    return "The selected Amp target repo identity does not match this checkout.";
  }
  if (
    ctx.environment.workspaceProvisionType === "managed-worktree" &&
    ctx.dirty
  ) {
    return "This BB managed worktree has uncommitted changes that the selected Amp Runner cannot see.";
  }
  return null;
}

async function buildHandoffPacket(
  bb: BbPluginApi,
  threadId: string,
  ctx: Awaited<ReturnType<typeof resolveContext>>,
  target: Target,
) {
  const output = await bb.sdk.threads.output({ threadId });
  const plan =
    output.output?.trim() || "No final BB planning output was available.";
  return [
    "Source: BB",
    `Repository: ${ctx.project.name}`,
    `BB Thread: ${ctx.thread.title ?? ctx.thread.titleFallback ?? threadId}`,
    `Runner: ${target.runnerId}`,
    `Branch: ${ctx.repo.branch ?? "unknown"}`,
    `HEAD: ${ctx.repo.head ?? "unknown"}`,
    "",
    "Objective / Plan:",
    truncate(plan, 24000),
    "",
    "Git state:",
    ctx.repo.dirty ? "dirty" : "clean",
    "",
    "Instructions:",
    "Re-read the repository before modifying anything.",
    "Treat the plan as context, not as authoritative code state.",
    "Verify assumptions against the current checkout.",
  ].join("\n");
}

async function repoFacts(
  bb: BbPluginApi,
  environmentId: string,
  repoPath: string,
  remote: string | null,
) {
  const status = await bb.sdk.environments.status({ environmentId });
  if (status.outcome === "unavailable") {
    // An offline host must not hide this thread's existing links and ACP
    // children; it only blocks starting new work.
    return {
      path: repoPath,
      branch: null,
      head: null,
      dirty: false,
      remoteHash: null,
      unavailable: `BB could not inspect this checkout: ${status.failure.message}`,
    };
  }
  const workspace = status.outcome === "available" ? status.workspace : null;
  const checkout = workspace?.checkout;
  const branch =
    checkout?.kind === "branch" || checkout?.kind === "unborn"
      ? checkout.branchName
      : null;
  const head =
    checkout?.kind === "branch" || checkout?.kind === "detached"
      ? checkout.headSha
      : null;
  return {
    path: repoPath,
    branch,
    head,
    dirty: workspace?.workingTree.hasUncommittedChanges ?? false,
    remoteHash: remote === null ? null : hashRemote(remote),
    unavailable: null as string | null,
  };
}

async function requireLink(
  bb: BbPluginApi,
  threadId: string,
  ampThreadId?: string,
) {
  const links = await readLinks(bb.storage.kv, threadId);
  const link = selectLink(links, ampThreadId);
  if (link !== null) return link;
  throw new Error(
    ampThreadId === undefined
      ? "This BB thread is not linked to Amp."
      : "That Amp thread is not linked to this BB thread.",
  );
}

/**
 * Direct BB children running the native `acp-amp` provider. BB owns those
 * threads and their transcripts; the plugin only reports that they exist so
 * the panel can navigate to them. A listing failure degrades to an empty
 * list rather than breaking the whole panel.
 */
async function listAcpChildren(bb: BbPluginApi, threadId: string) {
  try {
    // Fetched well above MAX_ACP_CHILDREN so the newest-first slice is
    // decided here rather than by BB's list ordering.
    const children = await bb.sdk.threads.list({
      parentThreadId: threadId,
      limit: 200,
    });
    return toAcpChildren(children);
  } catch (error) {
    bb.log.warn(
      `Could not list ACP child threads: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return [];
  }
}

async function requireLinkTarget(
  settings: ReturnType<BbPluginApi["settings"]["define"]>,
  link: AmpLink,
) {
  const values = await settings.get();
  const target = parseConfig(values.configJson).targets.find(
    (candidate) =>
      candidate.name === link.targetName &&
      candidate.runnerId === link.runnerId,
  );
  if (target === undefined) {
    throw new Error(
      "The Amp target for this existing thread link is no longer configured.",
    );
  }
  return target;
}

async function companionRequest(
  bb: BbPluginApi,
  settings: ReturnType<BbPluginApi["settings"]["define"]>,
  target: Target,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const values = await settings.get();
  if (
    typeof values.companionSecret !== "string" ||
    values.companionSecret.length < 24
  ) {
    throw new Error("Configure companionSecret before using Amp.");
  }
  const port = parseCompanionPort(values.companionPort);
  let response: Awaited<ReturnType<typeof requestThroughHost>>;
  try {
    response = await requestThroughHost(
      bb,
      target.bbHostId,
      target.companionClientPath,
      {
        method,
        path,
        port,
        secret: values.companionSecret,
        ...(body === undefined ? {} : { body }),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("TIMEOUT:"))
      throw error;
    throw new Error(
      `Companion is unavailable on the enrolled BB host: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  if (!response.ok) {
    const parsed = rpcErrorSchema.safeParse(response.body);
    throw new Error(
      parsed.success
        ? `${parsed.data.code}: ${parsed.data.message}`
        : "Companion request failed.",
    );
  }
  return response.body;
}
