# bb-plugin-amp

Thin BB-side companion for explicit handoff from a BB planning/review thread to
an existing Amp Runner through `amp-plugin-bb-companion`.

This plugin does not run Amp, manage runners, create worktrees, mirror
transcripts, or use `@ampcode/sdk` for runner execution.

## Configuration

Install from a checkout visible to the BB server:

```sh
bb plugin install /path/to/bb/plugins/amp --yes
```

Set:

```json
{
  "targets": [
    {
      "name": "Home Amp",
      "runnerId": "ice-by-snowboard",
      "bbHostId": "host_...",
      "repoRoot": "/home/exedev",
      "companionClientPath": "/home/exedev/.config/amp/plugins/bb-companion-client.mjs",
      "repoRemote": "optional remote URL"
    }
  ]
}
```

Use `bb plugin config amp set configJson '<json>'` for target mappings and
`bb plugin config amp set companionSecret '<generated secret>'` for the shared
secret. The secret must match the Amp companion config and is never sent to the
frontend.

`companionPort` defaults to:

```text
43931
```

Reload after config changes:

```sh
bb plugin reload amp
```

The BB server uses the stable `bb.sdk.terminals` host scope to launch the fixed
companion client on the enrolled machine. The client accepts one framed request
on stdin, forwards it to `127.0.0.1`, emits one framed JSON response, and exits.
It cannot execute a caller-supplied command or target a non-companion route.
Every request still requires the companion Bearer secret. No public share is
created.

## Behavior

The UI contributes:

- a compact `Amp` thread header action
- a thread side panel: `Send to Amp`, icon controls for refresh, cancel, and
  `Open in Amp`, a related-runs list, and a follow-up composer
- a read-through conversation view for the selected Amp thread, rendered with
  BB's native Markdown component

Conversation pages are fetched on demand from Amp's stable
`PluginThread.messages()` API. While Amp is working, the panel polls one
combined snapshot — status and the latest page for the same link — so the
header and the transcript always describe the same run. Ticks are chained
rather than fired on a fixed interval, so only one companion round-trip is
ever in flight, and repeated failures back off from two seconds to thirty.
Pages pulled in with `Load earlier` survive those refreshes. Messages are not
stored in BB KV;
thinking and tool payloads are not transported. Because Amp only permits
`messages()` while a thread is connected, the companion keeps a bounded,
in-memory cache of up to 100 normalized text messages for threads used during
its current process lifetime. The cache is not persisted across companion
reloads.

### Related Amp runs

One BB thread may relate to several Amp runs, and the panel lists them
together, newest first:

- **Companion** runs are Amp threads this plugin created through the
  companion. Selecting one points status, conversation, follow-up, cancel,
  and `Open in Amp` at that thread. Selection defaults to the newest run.
- **Native ACP** runs are direct BB child threads whose `providerId` is
  `acp-amp`. They are discovered through the public BB Plugin SDK
  (`bb.sdk.threads.list({ parentThreadId })`), labelled as such, shown with
  their BB title and live status, and opened with BB's own navigation.

ACP children are never adopted as companion links, and their transcripts are
never copied into plugin storage — BB already owns those threads. A failed
listing degrades to an empty list instead of breaking the panel.

### Stored links

`Send to Amp` creates one Amp thread per explicit invocation and stores only:

```ts
type AmpLink = {
  bbThreadId: string;
  ampThreadId: string;
  runnerId: string;
  targetName: string;
  createdAt: string;
  lastKnownState?: string;
  threadUrl?: string;
};
```

Links live in one bounded list per BB thread under `links:<bbThreadId>`
(newest first, one entry per Amp thread, at most 20). The pre-multi-link
`link:<bbThreadId>` row is still read when no list exists yet, so threads
linked by earlier versions keep their run; that legacy row is left in place
and folded into the list the next time a link is written.

Entries are parsed one at a time, so a single unreadable row costs only that
row. A list written by a future version is displayed where it parses but
never overwritten. Writes for one BB thread are serialized, so a send landing
during a status refresh cannot lose its new link. A `threadUrl` that is not
`http`/`https` is dropped rather than rendered as a link.

Creation stays idempotent per explicit Send: the frontend holds one invocation
id across retries of the same click, and the server reuses that invocation's
request id for nine minutes — including after success, so a retry that
follows a lost response returns the run that was already created instead of
starting a second one. Records are swept once expired. A new Send gets a new
invocation id, so it starts an additional Amp thread instead of overwriting
an earlier link. An existing link therefore never blocks sending.

The handoff packet is bounded and uses the final BB thread output plus repo
facts. It does not include hidden reasoning, credentials, full conversation
history, unrelated logs, or repository contents.

Managed worktrees are handled explicitly. If the BB environment is a managed
worktree and has uncommitted changes, implementation handoff is blocked because
the fixed Amp Runner checkout cannot see those files.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

`npm test` covers the contract helpers, the link store (legacy migration,
per-row parsing, version guard, write serialization), the idempotency
records, the RPC handlers (multi-link sends, replay after success, selection
routing, snapshots, send-block reasons, companion error mapping, ACP
discovery), the enrolled-host client framing, the panel's load sequencing,
transcript merging and poll backoff, and the related-runs rendering.

The panel can also be reviewed visually. The harness supplies BB's plugin
runtime with canned RPC responses and mounts the built bundle, so it renders
the shipped component and stylesheet rather than a replica:

```sh
npm run build
npm run preview -- --screenshot /tmp/amp-panel.png
npm run preview -- --width 280 --screenshot /tmp/amp-narrow.png
```
