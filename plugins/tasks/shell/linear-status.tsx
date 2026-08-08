import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { useLinearStatus, useTasksRpc } from "./data.js";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function LinearStatus() {
  const rpc = useTasksRpc();
  const status = useLinearStatus();
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const data = status.data;
  const syncing = refreshing || data?.syncing === true;

  const refresh = async () => {
    if (syncing) return;
    setRefreshing(true);
    setActionError(null);
    try {
      const result = await rpc.call("linearSyncNow", null);
      if (!result.ok)
        setActionError(
          result.error?.message ?? "Linear synchronization failed",
        );
      status.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Linear synchronization failed",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const error = actionError ?? data?.lastError?.message ?? status.error;
  const rateLimited =
    data?.lastError?.code === "LINEAR_RATE_LIMITED" && data.retryAt;

  return (
    <section aria-label="Linear status" className="px-2 pb-1.5">
      <div className="flex min-h-7 items-center gap-2 px-2 text-sm">
        <Icon
          name="ExternalLink"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="font-medium text-foreground">Linear</span>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto size-6 text-muted-foreground"
                aria-label="Refresh Linear"
                disabled={!data?.configured || syncing}
                onClick={() => void refresh()}
              >
                <Icon
                  name="RotateCcw"
                  className={syncing ? "size-3.5 animate-spin" : "size-3.5"}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Refresh Linear</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="px-2 text-xs text-muted-foreground">
        {!data
          ? "Loading…"
          : !data.configured
            ? "Not configured"
            : syncing
              ? "Syncing…"
              : data.viewerName
                ? `${data.viewerName} · ${data.activeIssueCount} active`
                : "Connected"}
      </div>
      {rateLimited ? (
        <div className="px-2 pt-0.5 text-xs text-warning">
          Resumes {formatTime(data.retryAt!)}
        </div>
      ) : error ? (
        <div role="alert" className="px-2 pt-0.5 text-xs text-destructive">
          {error}
        </div>
      ) : data?.lastSuccessfulSyncAt ? (
        <div className="px-2 pt-0.5 text-xs text-muted-foreground">
          Updated {formatTime(data.lastSuccessfulSyncAt)}
        </div>
      ) : null}
    </section>
  );
}
