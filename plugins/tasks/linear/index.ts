import type { BbPluginApi } from "@bb/plugin-sdk";
import type { TasksApiStore } from "../api/index.js";
import { publishProjectsChanged, publishTasksChanged } from "../api/index.js";
import { createLinearClient } from "./client.js";
import { createLinearMutationBridge } from "./mutations.js";
import type { LinearMappingStore } from "./store.js";
import { createLinearSyncService, type LinearSyncResult, type LinearSyncStatus } from "./sync.js";
import type { LinearClient } from "./types.js";

const POLL_MS = 5 * 60 * 1000;
const needsConfiguration = (message: string) =>
  Object.assign(new Error(message), { name: "NeedsConfigurationError" });

export interface LinearRuntime {
  mutations: ReturnType<typeof createLinearMutationBridge>;
  status(): Promise<LinearSyncStatus & { configured: boolean }>;
  sync(): Promise<LinearSyncResult>;
}

export function registerLinearIntegration(
  bb: BbPluginApi,
  store: TasksApiStore,
  mappings: LinearMappingStore,
): LinearRuntime {
  const settings = bb.settings.define({
    linearApiKey: {
      type: "string",
      label: "Linear API key",
      description: "Personal API key used to synchronize assigned Linear issues.",
      secret: true,
    },
  });
  let client: LinearClient | null = null;
  let service: ReturnType<typeof createLinearSyncService> | null = null;

  const configuredKey = async () => (await settings.get()).linearApiKey?.trim() || null;
  const getClient = async () => {
    const key = await configuredKey();
    if (!key) throw needsConfiguration("Configure the Linear API key and reload the plugin.");
    return (client ??= createLinearClient({ apiKey: key }));
  };
  const proxy: LinearClient = {
    viewerAssignedIssues: async (signal) => (await getClient()).viewerAssignedIssues(signal),
    issuesByIds: async (ids, signal) => (await getClient()).issuesByIds(ids, signal),
    teamStates: async (id, signal) => (await getClient()).teamStates(id, signal),
    updateIssue: async (id, input, signal) => (await getClient()).updateIssue(id, input, signal),
    createComment: async (id, body, signal) => (await getClient()).createComment(id, body, signal),
  };
  const getService = () => service ??= createLinearSyncService({
    client: proxy, mappings, store,
    publishProjectChanged: (id) => publishProjectsChanged(bb, id),
    publishTaskChanged: (taskId, projectId) => publishTasksChanged(bb, taskId, projectId),
    warn: (message) => bb.log.warn(message),
  });
  settings.onChange(() => { client = null; service = null; });

  const sync = async () => {
    if (!await configuredKey()) throw needsConfiguration("Configure the Linear API key and reload the plugin.");
    const result = await getService().sync();
    bb.realtime.publish("linear:changed", null);
    return result;
  };
  bb.background.service("linear-sync", {
    async start(signal) {
      if (!await configuredKey()) {
        bb.status.needsConfiguration("Configure the Linear API key and reload the plugin.");
        throw needsConfiguration("Configure the Linear API key and reload the plugin.");
      }
      while (!signal.aborted) {
        const status = getService().getStatus();
        if (!status.retryAt || Date.parse(status.retryAt) <= Date.now()) {
          try {
            const result = await sync();
            if (!result.ok) bb.log.warn(`Linear sync failed: ${result.error?.message ?? "Unknown error"}`);
          } catch (error) {
            if ((error as { name?: string }).name === "NeedsConfigurationError") throw error;
            bb.log.warn("Linear sync failed; retrying on the next tick");
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  return {
    mutations: createLinearMutationBridge({ client: proxy, mappings }),
    sync,
    async status() {
      const configured = Boolean(await configuredKey());
      if (!configured) bb.status.needsConfiguration("Configure the Linear API key and reload the plugin.");
      return { configured, ...getService().getStatus() };
    },
  };
}
