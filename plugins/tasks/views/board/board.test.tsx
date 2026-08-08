// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../../app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const task = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZT1",
  projectId: PROJECT_ID,
  number: 1,
  key: "TSK-1",
  title: "Mapped issue",
  description: "",
  status: "todo",
  priority: "none",
  dueDate: null,
  parentTaskId: null,
  position: 1,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  labelIds: [],
  linearMapped: true,
  linearSource: {
    identifier: "PER-1",
    url: "https://linear.app/acme/issue/PER-1",
  },
};

describe("board Linear mutation rollback", () => {
  it("reverts an optimistic drag and safely shows the typed error", async () => {
    const move = vi.fn(() => ({
      ok: false,
      error: { code: "LINEAR_API_ERROR", message: "Linear rejected this move" },
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `${PROJECT_ID}?view=board` },
      {
        rpc: {
          linearStatus: () => ({
            configured: false,
            syncing: false,
            viewerName: null,
            activeIssueCount: 0,
            lastSuccessfulSyncAt: null,
            lastAttemptAt: null,
            lastError: null,
            retryAt: null,
          }),
          listProjects: () => ({
            projects: [
              {
                id: PROJECT_ID,
                name: "Project",
                prefix: "TSK",
                nextTaskNumber: 2,
                color: "blue",
                folderId: null,
                linkedBbProjectId: null,
                createdAt: task.createdAt,
              },
            ],
          }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [task] }),
          listLabels: () => ({ labels: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          countAttachments: () => ({ count: 0 }),
          boardMove: move,
        },
      },
    );
    const card = (await slot.findByText("Mapped issue")).closest<HTMLElement>(
      "[data-task-key]",
    )!;
    const board = card.closest<HTMLElement>(".overflow-x-auto")!;
    board.getBoundingClientRect = () => ({
      left: 0,
      right: 1400,
      top: 0,
      bottom: 600,
      width: 1400,
      height: 600,
      x: 0,
      y: 0,
      toJSON() {},
    });
    const columns = Array.from(
      board.querySelectorAll<HTMLElement>("[data-board-column]"),
    );
    columns.forEach((column, index) => {
      const left = index * 230;
      column.getBoundingClientRect = () => ({
        left,
        right: left + 220,
        top: 0,
        bottom: 600,
        width: 220,
        height: 600,
        x: left,
        y: 0,
        toJSON() {},
      });
    });
    card.getBoundingClientRect = () => ({
      left: 230,
      right: 450,
      top: 40,
      bottom: 120,
      width: 220,
      height: 80,
      x: 230,
      y: 40,
      toJSON() {},
    });

    fireEvent.pointerDown(card, { button: 0, clientX: 240, clientY: 50 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 80 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 80 });

    await waitFor(() => expect(move).toHaveBeenCalledOnce());
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Linear rejected this move",
    );
    const revertedCard = (await slot.findByText("Mapped issue")).closest(
      "[data-task-key]",
    );
    expect(
      revertedCard
        ?.closest("[data-board-column]")
        ?.getAttribute("data-board-column"),
    ).toBe("todo");
  });
});
