import { useEffect, useRef, useState } from "react";
import {
  Markdown,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { AmpLogo } from "./amp-logo";
import { cn, formatHomePathForDisplay } from "./lib/utils";
import {
  IconButton,
  IconLink,
  RelatedRunsList,
  SectionHeading,
  StatusPill,
  buildRelatedRuns,
  type AcpChildView,
  type CompanionLinkView,
} from "./related-runs";
import {
  applyRefreshedLink,
  createLoadSequencer,
  isFollowupSubmitKey,
  isLiveState,
  mergeTranscript,
  nextPollDelay,
  type PanelState,
  type TranscriptMessage,
} from "./panel-state";
import type { rpcContract } from "./server";

function newInvocationId() {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function AmpHeaderButton() {
  const navigate = useBbNavigate();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 w-14 p-0.5 [&_svg]:!h-6 [&_svg]:!w-12"
      aria-label="Open Amp panel"
      onClick={() =>
        navigate.openThreadPanel({ actionId: "amp", title: "Amp" })
      }
    >
      <AmpLogo className="h-6 w-12" />
    </Button>
  );
}

function AmpPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<PanelState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Held across failed retries so one explicit Send stays a single Amp thread.
  const sendInvocation = useRef<string | null>(null);
  // Only the newest load may write state; see createLoadSequencer.
  const loads = useRef(createLoadSequencer());
  // Read by the realtime handler, which the host may have captured once.
  const selectedRef = useRef<string | null>(null);

  function selectRun(ampThreadId: string | null) {
    selectedRef.current = ampThreadId;
    setSelected(ampThreadId);
  }

  async function loadEarlier(ampThreadId: string, offset: number) {
    const page = await rpc.call("getMessages", {
      threadId,
      ampThreadId,
      offset,
    });
    setMessages((current) => mergeTranscript(current, page, "prepend"));
    setNextOffset(page.nextOffset);
  }

  async function load(ampThreadId = selectedRef.current) {
    const token = loads.current.begin();
    setError(null);
    try {
      const panel = (await rpc.call("getPanelState", {
        threadId,
        ...(ampThreadId === null ? {} : { ampThreadId }),
      })) as PanelState;
      if (!loads.current.isCurrent(token)) return;
      setState(panel);
      setNow(Date.now());
      selectRun(panel.link?.ampThreadId ?? null);
      if (panel.link === null) {
        setMessages([]);
        setNextOffset(null);
        return;
      }
      const page = await rpc.call("getMessages", {
        threadId,
        ampThreadId: panel.link.ampThreadId,
        offset: 0,
      });
      if (!loads.current.isCurrent(token)) return;
      setMessages(page.messages);
      setNextOffset(page.nextOffset);
    } catch (err) {
      if (!loads.current.isCurrent(token)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load(null);
    return () => loads.current.cancel();
  }, [threadId]);

  useRealtime(`amp:${threadId}`, () => {
    void load();
  });

  const liveState = state?.link?.lastKnownState;
  useEffect(() => {
    if (selected === null || !isLiveState(liveState)) return;
    // One companion round-trip at a time: every call spawns a terminal on
    // the enrolled host, so ticks are chained rather than fired on a fixed
    // interval, and repeated failures back off.
    let timer = 0;
    let stopped = false;
    let errors = 0;

    const tick = async () => {
      // Observed, not claimed: a tick yields to any load started meanwhile
      // without cancelling one the user just triggered.
      const token = loads.current.current();
      try {
        const snapshot = await rpc.call("getRunSnapshot", {
          threadId,
          ampThreadId: selected,
          offset: 0,
        });
        if (stopped || !loads.current.isCurrent(token)) return;
        errors = 0;
        setNow(Date.now());
        setState((current) =>
          current === null
            ? current
            : applyRefreshedLink(current, snapshot.link),
        );
        if (snapshot.page !== null) {
          const page = snapshot.page;
          setMessages((current) => mergeTranscript(current, page));
        }
      } catch (err) {
        if (stopped || !loads.current.isCurrent(token)) return;
        errors += 1;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!stopped)
          timer = window.setTimeout(schedule, nextPollDelay(errors));
      }
    };
    const schedule = () => void tick();

    timer = window.setTimeout(schedule, nextPollDelay(0));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [threadId, selected, liveState]);

  async function run<T>(
    fn: () => Promise<T>,
    options: { reload?: boolean } = {},
  ) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (options.reload !== false) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * A failed Send keeps its invocation id, so retrying it resolves to the
   * same Amp thread. A completed Send clears it, so the next click is a new
   * explicit run alongside the existing links.
   */
  async function send() {
    const invocationId = sendInvocation.current ?? newInvocationId();
    sendInvocation.current = invocationId;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("sendToAmp", {
        threadId,
        mode: "high",
        invocationId,
      });
      sendInvocation.current = null;
      await load(result.link.ampThreadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function submitFollowup() {
    const message = followup.trim();
    if (link === null || busy || message.length === 0) return;
    void run(async () => {
      await rpc.call("sendFollowup", {
        threadId,
        ampThreadId: link.ampThreadId,
        message,
      });
      setFollowup("");
    });
  }

  const link = state?.link ?? null;
  const runs = buildRelatedRuns(state?.links ?? [], state?.acpChildren ?? []);
  const repoPath = state?.repo?.path;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant={link === null ? "default" : "outline"}
          disabled={busy || state?.canSend !== true}
          onClick={send}
        >
          {link === null ? "Send to Amp" : "New Amp run"}
        </Button>
        {link !== null ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusPill
              status={link.lastKnownState ?? "unknown"}
              className="px-1"
            />
            <IconButton
              icon="RotateCcw"
              label="Refresh Amp status"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  rpc.call("refreshStatus", {
                    threadId,
                    ampThreadId: link.ampThreadId,
                  }),
                )
              }
            />
            <IconButton
              icon="X"
              label="Cancel Amp run"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  rpc.call("cancelAmp", {
                    threadId,
                    ampThreadId: link.ampThreadId,
                  }),
                )
              }
            />
            {link.threadUrl ? (
              <IconLink
                icon="ExternalLink"
                label="Open in Amp"
                href={link.threadUrl}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Runner</dt>
        <dd className="min-w-0 truncate">
          {state?.selectedTarget?.runnerId ??
            link?.runnerId ??
            "Not configured"}
        </dd>
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="min-w-0 truncate" title={repoPath}>
          {repoPath === undefined
            ? "Unknown"
            : formatHomePathForDisplay(repoPath)}
        </dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="min-w-0 truncate">{state?.repo?.branch ?? "Unknown"}</dd>
        <dt className="text-muted-foreground">Amp thread</dt>
        <dd className="min-w-0 truncate" title={link?.ampThreadId}>
          {link?.ampThreadId ?? "None selected"}
        </dd>
      </dl>

      {state?.reason ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="Info" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{state.reason}</span>
        </p>
      ) : null}
      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <Icon name="AlertCircle" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <SectionHeading>
          Related Amp runs
          {runs.length > 0 ? (
            <span className="font-normal normal-case tracking-normal">
              {runs.length}
            </span>
          ) : null}
        </SectionHeading>
        <RelatedRunsList
          runs={runs}
          selectedAmpThreadId={selected}
          now={now}
          onSelect={(ampThreadId) => {
            if (ampThreadId === selected || busy) return;
            // Recorded before the request so a realtime signal arriving
            // mid-flight reloads this run rather than the previous one.
            selectRun(ampThreadId);
            setBusy(true);
            void load(ampThreadId).finally(() => setBusy(false));
          }}
          onOpenThread={(bbThreadId) => navigate.toThread(bbThreadId)}
        />
      </section>

      {link !== null ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <SectionHeading>Conversation</SectionHeading>
            {nextOffset !== null ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs font-normal"
                disabled={busy}
                onClick={() =>
                  void run(() => loadEarlier(link.ampThreadId, nextOffset), {
                    reload: false,
                  })
                }
              >
                Load earlier
              </Button>
            ) : null}
          </div>
          {messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">No messages yet.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    "min-w-0 border-l-2 pl-3",
                    message.role === "assistant"
                      ? "border-primary"
                      : "border-border",
                  )}
                >
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {message.role === "assistant" ? "Amp" : "You"}
                  </div>
                  <Markdown content={message.text} className="text-sm" />
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {link !== null ? (
        <section className="flex flex-col gap-2">
          <textarea
            className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-sans text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Follow up on Amp thread ${link.ampThreadId}`}
            placeholder="Follow up on this Amp run…"
            value={followup}
            onChange={(event) => setFollowup(event.target.value)}
            onKeyDown={(event) => {
              if (
                !isFollowupSubmitKey({
                  key: event.key,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  isComposing: event.nativeEvent.isComposing,
                })
              )
                return;
              event.preventDefault();
              submitFollowup();
            }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || followup.trim().length === 0}
              onClick={submitFollowup}
            >
              Send
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "amp",
    title: "Amp",
    component: () => <AmpHeaderButton />,
  });

  app.slots.threadPanelAction({
    id: "amp",
    title: "Amp",
    iconOnly: true,
    component: ({ threadId }) => <AmpPanel threadId={threadId} />,
  });
});
