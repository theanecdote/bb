import type { PluginAPI, PluginThread, ThreadID } from "@ampcode/plugin";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export const description =
  "Local authenticated BB companion for creating Amp threads on configured live runners.";

type BridgeState =
  | "created"
  | "running"
  | "waiting"
  | "idle"
  | "failed"
  | "cancelled"
  | "unknown";
type Mode = "low" | "medium" | "high" | "ultra";

type CompanionConfig = {
  enabled: boolean;
  control: boolean;
  port: number;
  secret: string;
  allowedRunners: string[];
  maxMessageBytes: number;
  threadUrlBase?: string;
};

type StoredThread = {
  thread: PluginThread;
  state: BridgeState;
  threadUrl?: string;
};

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 43931;
const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "amp",
  "bb-companion.json",
);
const MAX_BODY_BYTES = 128 * 1024;
const REQUEST_ID_TTL_MS = 10 * 60 * 1000;

export default async function plugin(amp: PluginAPI) {
  const config = parseConfig(await readProtectedConfig());
  if (!config.enabled) {
    amp.logger.log("bb-companion disabled");
    return;
  }
  if (!config.control) {
    amp.logger.log("bb-companion loaded as non-control instance");
    return;
  }

  const threads = new Map<string, StoredThread>();
  const requestIds = new Map<string, { threadId: string; expiresAt: number }>();

  const server = createServer((req, res) => {
    void handleRequest(amp, config, threads, requestIds, req, res).catch(
      (error) => {
        amp.logger.log("bb-companion request failed", publicError(error).code);
        writeJson(res, 500, publicError(error));
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  amp.logger.log(`bb-companion listening on ${LOOPBACK_HOST}:${config.port}`);
  amp.onDispose(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

async function readProtectedConfig() {
  const configPath = process.env.BB_COMPANION_CONFIG ?? DEFAULT_CONFIG_PATH;
  const fileStat = await stat(configPath);
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error(
      "bb-companion config must be readable and writable by its owner only",
    );
  }
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (!isRecord(parsed))
    throw new Error("bb-companion config must contain a JSON object");
  return parsed;
}

async function handleRequest(
  amp: PluginAPI,
  config: CompanionConfig,
  threads: Map<string, StoredThread>,
  requestIds: Map<string, { threadId: string; expiresAt: number }>,
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (!authenticate(req, config.secret)) {
    writeJson(res, 401, { code: "UNAUTHORIZED", message: "Unauthorized." });
    return;
  }
  if (!["GET", "POST"].includes(req.method ?? "")) {
    writeJson(res, 405, {
      code: "INVALID_REQUEST",
      message: "Method is not allowed.",
    });
    return;
  }
  if (req.method === "POST" && !contentTypeIsJson(req)) {
    writeJson(res, 415, {
      code: "INVALID_REQUEST",
      message: "Expected application/json.",
    });
    return;
  }

  expireRequestIds(requestIds);
  const url = new URL(req.url ?? "/", "http://unix");
  const route = matchRoute(req.method ?? "", url.pathname);
  if (route === null) {
    writeJson(res, 404, {
      code: "INVALID_REQUEST",
      message: "Unknown endpoint.",
    });
    return;
  }

  if (route.kind === "create") {
    const body = await readJson(req, MAX_BODY_BYTES);
    const input = validateCreate(body, config);
    const existing = requestIds.get(input.requestId);
    if (existing) {
      const stored = threads.get(existing.threadId);
      if (stored) {
        writeJson(res, 200, threadResponse(existing.threadId, stored));
        return;
      }
    }

    const agent = amp.getBuiltinAgent(input.mode);
    let thread: PluginThread;
    try {
      thread = await agent.createThread({
        executor: { type: "runner", id: input.runnerId },
      });
    } catch (error) {
      writeJson(res, 503, {
        code: runnerUnavailable(error)
          ? "RUNNER_UNAVAILABLE"
          : "THREAD_CREATION_FAILED",
        message: "Amp could not create a thread on the configured runner.",
      });
      return;
    }

    const threadUrl = buildThreadUrl(amp, config, thread.id);
    const stored: StoredThread = { thread, state: "created", threadUrl };
    threads.set(thread.id, stored);
    requestIds.set(input.requestId, {
      threadId: thread.id,
      expiresAt: Date.now() + REQUEST_ID_TTL_MS,
    });
    await appendUserMessage(thread, input.message, stored);
    writeJson(res, 201, threadResponse(thread.id, stored));
    return;
  }

  const stored = threads.get(route.threadId) ?? {
    thread: amp.threads.get(route.threadId as ThreadID),
    state: "unknown" as BridgeState,
    threadUrl: buildThreadUrl(amp, config, route.threadId),
  };

  if (route.kind === "get") {
    await refreshState(stored);
    writeJson(res, 200, threadResponse(route.threadId, stored));
    return;
  }

  if (route.kind === "message") {
    const body = await readJson(req, MAX_BODY_BYTES);
    const message = validateMessage(body, config);
    await appendUserMessage(stored.thread, message, stored);
    threads.set(route.threadId, stored);
    writeJson(res, 200, threadResponse(route.threadId, stored));
    return;
  }

  if (route.kind === "cancel") {
    try {
      await stored.thread.cancel();
      stored.state = "cancelled";
      threads.set(route.threadId, stored);
      writeJson(res, 200, threadResponse(route.threadId, stored));
    } catch {
      writeJson(res, 500, {
        code: "AMP_API_ERROR",
        message: "Amp could not cancel the thread.",
      });
    }
  }
}

export function parseConfig(raw: Record<string, unknown>): CompanionConfig {
  const allowedRunners = Array.isArray(raw.allowedRunners)
    ? raw.allowedRunners.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  return {
    enabled: raw.enabled === true,
    control: raw.control !== false,
    port:
      typeof raw.port === "number" &&
      Number.isInteger(raw.port) &&
      raw.port >= 1 &&
      raw.port <= 65535
        ? raw.port
        : DEFAULT_PORT,
    secret: typeof raw.secret === "string" ? raw.secret : "",
    allowedRunners,
    maxMessageBytes:
      typeof raw.maxMessageBytes === "number" && raw.maxMessageBytes > 0
        ? Math.min(raw.maxMessageBytes, MAX_BODY_BYTES)
        : 64 * 1024,
    threadUrlBase:
      typeof raw.threadUrlBase === "string" ? raw.threadUrlBase : undefined,
  };
}

export function validateCreate(body: unknown, config: CompanionConfig) {
  if (!isRecord(body))
    throw typedError("INVALID_REQUEST", "Body must be an object.");
  const requestId = stringField(body, "requestId", 8, 120);
  if (!/^[A-Za-z0-9._:-]+$/.test(requestId))
    throw typedError("INVALID_REQUEST", "Invalid requestId.");
  const runnerId = stringField(body, "runnerId", 1, 120);
  if (!config.allowedRunners.includes(runnerId))
    throw typedError("RUNNER_NOT_ALLOWED", "Runner is not allowed.");
  const mode = stringField(body, "mode", 1, 12) as Mode;
  if (!["low", "medium", "high", "ultra"].includes(mode))
    throw typedError("INVALID_REQUEST", "Unsupported mode.");
  const message = stringField(body, "message", 1, config.maxMessageBytes);
  const metadata = body.metadata;
  if (metadata !== undefined && JSON.stringify(metadata).length > 4096) {
    throw typedError("INVALID_REQUEST", "Metadata is too large.");
  }
  return { requestId, runnerId, mode, message };
}

export function validateMessage(body: unknown, config: CompanionConfig) {
  if (!isRecord(body))
    throw typedError("INVALID_REQUEST", "Body must be an object.");
  return stringField(body, "message", 1, config.maxMessageBytes);
}

async function appendUserMessage(
  thread: PluginThread,
  message: string,
  stored: StoredThread,
) {
  stored.state = "running";
  await thread.appendUserMessage({ type: "user-message", content: message });
  void thread
    .waitForResponse({ timeoutMs: 30 * 60 * 1000 })
    .then(() => {
      stored.state = "idle";
    })
    .catch(() => {
      stored.state = "failed";
    });
}

async function refreshState(stored: StoredThread) {
  try {
    const state = await stored.thread.state.get();
    stored.state =
      state === "running"
        ? "running"
        : state === "awaiting-approval"
          ? "waiting"
          : state === "error"
            ? "failed"
            : "idle";
  } catch {
    stored.state = "unknown";
  }
}

export function matchRoute(method: string, path: string) {
  if (method === "POST" && path === "/v1/threads")
    return { kind: "create" as const };
  const match = path.match(/^\/v1\/threads\/([^/]+)(?:\/(messages|cancel))?$/);
  if (!match) return null;
  const threadId = decodeURIComponent(match[1]);
  if (!/^T-[A-Za-z0-9_-]+$/.test(threadId)) return null;
  if (method === "GET" && !match[2]) return { kind: "get" as const, threadId };
  if (method === "POST" && match[2] === "messages")
    return { kind: "message" as const, threadId };
  if (method === "POST" && match[2] === "cancel")
    return { kind: "cancel" as const, threadId };
  return null;
}

async function readJson(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit)
      throw typedError("INVALID_REQUEST", "Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw typedError("INVALID_REQUEST", "Malformed JSON.");
  }
}

function authenticate(req: IncomingMessage, secret: string) {
  if (secret.length < 24) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function buildThreadUrl(
  amp: PluginAPI,
  config: CompanionConfig,
  threadId: string,
) {
  const base = config.threadUrlBase ?? amp.system.ampURL.toString();
  return new URL(`/threads/${threadId}`, base).toString();
}

function threadResponse(threadId: string, stored: StoredThread) {
  return { threadId, state: stored.state, threadUrl: stored.threadUrl };
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function contentTypeIsJson(req: IncomingMessage) {
  const value = req.headers["content-type"];
  return (
    typeof value === "string" &&
    value.toLowerCase().split(";")[0].trim() === "application/json"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
) {
  const value = body[key];
  if (
    typeof value !== "string" ||
    value.length < min ||
    Buffer.byteLength(value) > max
  ) {
    throw typedError("INVALID_REQUEST", `Invalid ${key}.`);
  }
  return value;
}

function typedError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function publicError(error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: "AMP_API_ERROR", message: "Amp companion failed." };
}

function runnerUnavailable(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /runner|unavailable|not found|offline/i.test(text);
}

function expireRequestIds(
  requestIds: Map<string, { threadId: string; expiresAt: number }>,
) {
  const now = Date.now();
  for (const [requestId, entry] of requestIds) {
    if (entry.expiresAt <= now) requestIds.delete(requestId);
  }
}
