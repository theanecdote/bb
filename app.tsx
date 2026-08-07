import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

function Button({
  className = "",
  variant = "default",
  size: _size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline";
  size?: "sm";
}) {
  return (
    <button
      className={`inline-flex h-8 items-center justify-center rounded-md border px-3 text-sm font-medium disabled:pointer-events-none disabled:opacity-50 ${
        variant === "outline"
          ? "border-border bg-background text-foreground hover:bg-muted"
          : "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
      } ${className}`}
      {...props}
    />
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-lg border border-border bg-card">{children}</section>;
}

function CardHeader({ children }: { children: ReactNode }) {
  return <div className="border-b border-border px-4 py-3">{children}</div>;
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

function CardContent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}

const linkButtonClass =
  "inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted";

type PanelState = Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>>;

function AmpHeaderButton({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label="Open Amp panel"
      onClick={() => navigate.openThreadPanel({ actionId: "amp", title: "Amp" })}
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

  async function load() {
    setError(null);
    try {
      setState(await rpc.call("getPanelState", { threadId }));
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

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
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
                  <a
                    className={linkButtonClass}
                    href={link.threadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Amp
                  </a>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(() => rpc.call("refreshStatus", { threadId }))}
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
