import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "../server";

afterEach(() => vi.unstubAllGlobals());

describe("Linear production lifecycle", () => {
  it("registers a secret, strict safe RPC, configuration status, and one service", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    expect(harness.registrations.settingsDescriptors.linearApiKey).toMatchObject({ secret: true, type: "string" });
    expect(harness.registrations.services.filter(({ name }) => name === "linear-sync")).toHaveLength(1);
    const status = await harness.callRpc("linearStatus", null);
    expect(status).toMatchObject({ configured: false, viewerName: null, activeIssueCount: 0 });
    expect(JSON.stringify(status)).not.toContain("linearApiKey");
    expect(harness.needsConfigurationMessages).toHaveLength(1);
    await harness.dispose();
  });

  it("contains unauthorized credentials and accepts key rotation", async () => {
    const fetch = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "secret-one" } });
    await plugin(bb);
    const first = await harness.callRpc("linearSyncNow", null);
    expect(first).toMatchObject({ ok: false, error: { code: "LINEAR_API_ERROR" } });
    expect(JSON.stringify(first)).not.toContain("secret-one");
    await harness.setSettings({ linearApiKey: "secret-two" });
    await harness.callRpc("linearSyncNow", null);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "secret-two" });
    await harness.dispose();
  });
});
