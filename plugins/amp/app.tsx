import { useEffect, useState } from "react";
import {
  Markdown,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@bb/shared-ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@bb/shared-ui/card";

type PanelState = Awaited<
  ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>
>;

type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

function AmpHeaderButton({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label="Open Amp panel"
      onClick={() =>
        navigate.openThreadPanel({ actionId: "amp", title: "Amp" })
      }
    >
      Amp
    </Button>
  );
}

function AmpPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  async function loadMessages(offset = 0, prepend = false) {
    const page = await rpc.call("getMessages", { threadId, offset });
    setMessages((current) => {
      const combined = prepend ? [...page.messages, ...current] : page.messages;
      return combined.filter(
        (message, index) =>
          combined.findIndex((candidate) => candidate.id === message.id) ===
          index,
      );
    });
    setNextOffset(page.nextOffset);
  }

  async function load() {
    setError(null);
    try {
      const panel = await rpc.call("getPanelState", { threadId });
      setState(panel);
      if (panel.link) await loadMessages();
      else {
        setMessages([]);
        setNextOffset(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, [threadId]);

  useRealtime(`amp:${threadId}`, () => {
    void load();
  });

  useEffect(() => {
    const status = state?.link?.lastKnownState;
    if (!state?.link || !["created", "running", "waiting"].includes(status))
      return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const refreshed = await rpc.call("refreshStatus", { threadId });
          setState((current: any) => ({
            ...current,
            link: refreshed.link,
          }));
          await loadMessages();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [threadId, state?.link?.lastKnownState]);

  async function run<T>(fn: () => Promise<T>, reload = true) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (reload) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const link = state?.link;
  const target = state?.selectedTarget;

  return (
    <div className="space-y-3 text-sm">
      <Card>
        <CardHeader>
          <CardTitle>Amp</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
            <dt className="text-muted-foreground">Runner</dt>
            <dd>{target?.runnerId ?? link?.runnerId ?? "Not configured"}</dd>
            <dt className="text-muted-foreground">Repository</dt>
            <dd className="break-all">{state?.repo?.path ?? "Unknown"}</dd>
            <dt className="text-muted-foreground">Thread</dt>
            <dd className="break-all">{link?.ampThreadId ?? "Not linked"}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{link?.lastKnownState ?? "Not linked"}</dd>
          </dl>

          {state?.reason ? (
            <div className="rounded-md border border-border px-3 py-2 text-muted-foreground">
              {state.reason}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 px-3 py-2 text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {!link ? (
              <Button
                size="sm"
                disabled={busy || !state?.canSend}
                onClick={() =>
                  run(() => rpc.call("sendToAmp", { threadId, mode: "high" }))
                }
              >
                Send to Amp
              </Button>
            ) : (
              <>
                {link.threadUrl ? (
                  <Button size="sm" variant="outline" asChild>
                    <a href={link.threadUrl} target="_blank" rel="noreferrer">
                      Open in Amp
                    </a>
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(() => rpc.call("refreshStatus", { threadId }))
                  }
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(() => rpc.call("cancelAmp", { threadId }))}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {link ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Conversation</CardTitle>
              {nextOffset !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(() => loadMessages(nextOffset, true), false)
                  }
                >
                  Load earlier
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {messages.length === 0 ? (
              <div className="text-muted-foreground">No messages yet.</div>
            ) : (
              <div className="space-y-5">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={
                      message.role === "assistant"
                        ? "border-l-2 border-primary pl-3"
                        : "border-l-2 border-border pl-3"
                    }
                  >
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      {message.role === "assistant" ? "Amp" : "You"}
                    </div>
                    <Markdown content={message.text} />
                  </article>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {link ? (
        <Card>
          <CardHeader>
            <CardTitle>Follow-up</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={followup}
              onChange={(event) => setFollowup(event.target.value)}
            />
            <Button
              size="sm"
              disabled={busy || followup.trim().length === 0}
              onClick={() =>
                run(async () => {
                  await rpc.call("sendFollowup", {
                    threadId,
                    message: followup.trim(),
                  });
                  setFollowup("");
                })
              }
            >
              Send Follow-up
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "amp",
    title: "Amp",
    component: ({ threadId }) => <AmpHeaderButton threadId={threadId} />,
  });

  app.slots.threadPanelAction({
    id: "amp",
    title: "Amp",
    icon: "Zap",
    component: ({ threadId }) => <AmpPanel threadId={threadId} />,
  });
});
