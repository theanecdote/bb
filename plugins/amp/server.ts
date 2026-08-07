import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AmpLinkSchema,
  AmpStateSchema,
  StatusSchema,
  TargetSchema,
  buildSharedPortUrl,
  hashRemote,
  parseCompanionPort,
  parseConfig,
  selectTarget,
  truncate,
  type AmpLink,
  type Target,
} from "./contract";

const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const rpcContract = defineRpcContract({
  getPanelState: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      configured: z.boolean(),
      targets: z.array(TargetSchema),
      selectedTarget: TargetSchema.nullable(),
      link: AmpLinkSchema.nullable(),
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
      })
      .strict(),
    output: z.object({ link: AmpLinkSchema }),
  },
  sendFollowup: {
    input: z
      .object({
        threadId: z.string(),
        message: z.string().min(1).max(12000),
      })
      .strict(),
    output: z.object({ state: AmpStateSchema }),
  },
  refreshStatus: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      link: AmpLinkSchema.nullable(),
      status: StatusSchema.nullable(),
    }),
  },
  cancelAmp: {
    input: z.object({ threadId: z.string() }).strict(),
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
    async getPanelState({ threadId }) {
      const ctx = await resolveContext(bb, settings, threadId);
      const target = selectTarget(
        ctx.targets,
        ctx.environment.hostId,
        ctx.repoPath,
      );
      const link = await getLink(bb, threadId);
      const reason = await sendBlockReason(ctx, target, link !== null);
      return {
        configured: ctx.targets.length > 0,
        targets: ctx.targets,
        selectedTarget: target,
        link,
        canSend: reason === null,
        reason,
        managedWorktree:
          ctx.environment.workspaceProvisionType === "managed-worktree",
        dirty: ctx.dirty,
        repo: ctx.repo,
      };
    },
    async sendToAmp({ threadId, targetName, mode }) {
      const ctx = await resolveContext(bb, settings, threadId);
      const target =
        targetName === undefined
          ? selectTarget(ctx.targets, ctx.environment.hostId, ctx.repoPath)
          : (ctx.targets.find((candidate) => candidate.name === targetName) ??
            null);
      const reason = await sendBlockReason(
        ctx,
        target,
        (await getLink(bb, threadId)) !== null,
      );
      if (reason !== null || target === null)
        throw new Error(reason ?? "No Amp target selected.");

      const requestId = randomUUID();
      const packet = await buildHandoffPacket(bb, threadId, ctx, target);
      const response = await companionRequest(
        bb,
        settings,
        target,
        "POST",
        "/v1/threads",
        {
          requestId,
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
        threadUrl: parsed.threadUrl,
      };
      await setLink(bb, link);
      bb.realtime.publish(`amp:${threadId}`, { type: "link-updated" });
      return { link };
    },
    async sendFollowup({ threadId, message }) {
      const link = await requireLink(bb, threadId);
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
      await setLink(bb, {
        ...link,
        lastKnownState: parsed.state,
        threadUrl: parsed.threadUrl ?? link.threadUrl,
      });
      bb.realtime.publish(`amp:${threadId}`, { type: "link-updated" });
      return { state: parsed.state };
    },
    async refreshStatus({ threadId }) {
      const link = await getLink(bb, threadId);
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
      await setLink(bb, nextLink);
      return { link: nextLink, status };
    },
    async cancelAmp({ threadId }) {
      const link = await requireLink(bb, threadId);
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
      await setLink(bb, { ...link, lastKnownState: status.state });
      bb.realtime.publish(`amp:${threadId}`, { type: "link-updated" });
      return { state: status.state };
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

async function sendBlockReason(
  ctx: Awaited<ReturnType<typeof resolveContext>>,
  target: Target | null,
  alreadyLinked: boolean,
) {
  if (alreadyLinked)
    return "This BB thread is already linked to an Amp thread.";
  if (ctx.targets.length === 0) return "No Amp target mappings are configured.";
  if (target === null)
    return "No single Amp target matches this BB host and canonical repo path.";
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
    throw new Error(
      `BB could not inspect this checkout: ${status.failure.message}`,
    );
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
  };
}

async function getLink(bb: BbPluginApi, threadId: string) {
  const raw = await bb.storage.kv.get(`link:${threadId}`);
  const parsed = AmpLinkSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function requireLink(bb: BbPluginApi, threadId: string) {
  const link = await getLink(bb, threadId);
  if (link === null) throw new Error("This BB thread is not linked to Amp.");
  return link;
}

async function setLink(bb: BbPluginApi, link: AmpLink) {
  await bb.storage.kv.set(`link:${link.bbThreadId}`, link);
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
  bb.hosts.declareSharedPorts(target.bbHostId, [port]);
  const tunnel = await bb.hosts.ensureSharedPortTunnel(target.bbHostId);
  const url = buildSharedPortUrl(tunnel.label, tunnel.baseDomain, port, path);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${values.companionSecret}`,
        accept: "application/json",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { body: payload } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("TIMEOUT: Companion request timed out.");
    }
    throw new Error("Companion is unavailable through the enrolled BB host.");
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Companion returned invalid JSON.");
    }
  }
  if (!response.ok) {
    const parsed = rpcErrorSchema.safeParse(json);
    throw new Error(
      parsed.success
        ? `${parsed.data.code}: ${parsed.data.message}`
        : "Companion request failed.",
    );
  }
  return json;
}
