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
- a thread side panel with `Send to Amp`, `Open in Amp`, `Refresh`, `Cancel`,
  and `Send Follow-up`

`Send to Amp` creates one Amp thread for the BB thread and stores only:

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
