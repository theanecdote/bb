// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseStatus = {
  configured: true,
  syncing: false,
  viewerName: "Ada Lovelace",
  activeIssueCount: 7,
  lastSuccessfulSyncAt: "2026-08-08T12:00:00.000Z",
  lastAttemptAt: "2026-08-08T12:00:00.000Z",
  lastError: null,
  retryAt: null,
};

function rpc(
  status: Record<string, unknown>,
  sync = () => ({
    ok: true,
    createdProjects: 0,
    createdTasks: 0,
    updatedTasks: 0,
    deactivatedTasks: 0,
  }),
) {
  return {
    linearStatus: () => ({ ...baseStatus, ...status }),
    linearSyncNow: sync,
    listProjects: () => ({ projects: [] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listTasks: () => ({ tasks: [] }),
  };
}

function render(status: Record<string, unknown>, sync?: () => unknown) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "all" },
    { rpc: rpc(status, sync as never) },
  );
}

describe("Linear sidebar status", () => {
  it("renders not configured, connected, syncing, rate limited, and failed states", async () => {
    let slot = render({
      configured: false,
      viewerName: null,
      activeIssueCount: 0,
      lastSuccessfulSyncAt: null,
    });
    await slot.findByText("Not configured");
    expect(
      (
        slot.getByRole("button", {
          name: "Refresh Linear",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    slot.lifecycle.unmount();

    slot = render({});
    await slot.findByText("Ada Lovelace · 7 active");
    expect(slot.getByText(/Updated/)).toBeTruthy();
    slot.lifecycle.unmount();

    slot = render({ syncing: true });
    await slot.findByText("Syncing…");
    expect(
      (
        slot.getByRole("button", {
          name: "Refresh Linear",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    slot.lifecycle.unmount();

    slot = render({
      lastError: { code: "LINEAR_RATE_LIMITED", message: "Rate limited" },
      retryAt: "2026-08-08T13:00:00.000Z",
    });
    await slot.findByText(/Resumes/);
    expect(slot.queryByText("Rate limited")).toBeNull();
    slot.lifecycle.unmount();

    slot = render({
      lastError: { code: "LINEAR_API_ERROR", message: "Linear is unavailable" },
    });
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Linear is unavailable",
    );
  });

  it("single-flights clicks and refreshes status after success", async () => {
    let resolve!: (value: unknown) => void;
    const sync = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const slot = render({ lastSuccessfulSyncAt: null }, sync);
    const button = await slot.findByRole("button", { name: "Refresh Linear" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(sync).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve({
      ok: true,
      createdProjects: 0,
      createdTasks: 0,
      updatedTasks: 0,
      deactivatedTasks: 0,
    });
    await waitFor(() =>
      expect(
        slot.rpcCalls.filter((call) => call.method === "linearStatus").length,
      ).toBeGreaterThan(1),
    );
  });
});
