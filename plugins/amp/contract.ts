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

export const AmpLinkSchema = z.object({
  bbThreadId: z.string(),
  ampThreadId: z.string(),
  runnerId: z.string(),
  targetName: z.string(),
  createdAt: z.string(),
  lastKnownState: AmpStateSchema.optional(),
  threadUrl: z.string().optional(),
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
  threadUrl: z.string().optional(),
});

export type AmpLink = z.infer<typeof AmpLinkSchema>;
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
