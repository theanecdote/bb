import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import { createStore, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { registerMentions } from "./mentions";
import { createLinearMappingStore } from "./linear/store";
import { registerLinearIntegration } from "./linear/index";

export const TASKS_PLUGIN_NAME = "Tasks";
export const TASKS_PLUGIN_VERSION = "0.1.1";

export const tasksRpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ ok: z.literal(true), version: z.string() }),
  },
});

function statusPayload() {
  return { name: TASKS_PLUGIN_NAME, version: TASKS_PLUGIN_VERSION };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`${TASKS_PLUGIN_NAME} ${TASKS_PLUGIN_VERSION} loaded`);

  const database = bb.storage.database();
  let mappings: ReturnType<typeof createLinearMappingStore> | undefined;
  const store = createStore(
    database,
    (taskId) => mappings?.getIssueMappingByTask(taskId) !== undefined,
    (taskIds) => {
      const result = new Map<string, { identifier: string; url: string }>();
      for (const [taskId, mapping] of mappings?.getIssueMappingsByTasks(
        taskIds,
      ) ?? [])
        result.set(taskId, {
          identifier: mapping.identifier,
          url: mapping.url,
        });
      return result;
    },
  );
  mappings = createLinearMappingStore(database);
  const linear = registerLinearIntegration(bb, store, mappings);
  const domain = registerTasksApi(bb, store, linear.mutations, linear);
  registerAttachments(bb, store.tasks, { mutations: linear.mutations });
  registerTasksCli(
    bb,
    store,
    statusPayload(),
    linear,
    linear.mutations,
    domain,
  );
  registerDelegation(bb, store, linear.mutations);
  registerMentions(bb, store);
  await registerLifecycle(bb, store);

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: TASKS_PLUGIN_VERSION };
    },
  });
}
