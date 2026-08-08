# Amp ACP Provider Design

## Objective

Expose Amp as a native BB ACP provider on the enrolled exe.dev machine while
preserving the existing `bb-plugin-amp` companion integration and the running
named Amp Runner.

## Source And Trust

Use the curated ACP Registry `amp-acp` 0.9.0 Linux x64 binary only as the
verified baseline and rollback artifact. The adapter is a third-party project,
not an Amp-owned component. Verify the Registry archive SHA-256 before
preserving it as `/home/exedev/.local/bin/amp-acp.registry-0.9.0`.

The final runtime installation is the approved patched source build from
upstream commit `68f0a16ebd437e51c9bf4d7a2b47c981010dc9a1` and
`integrations/amp-acp/patches/0001-bb-session-load.patch`, built with pinned
Bun for `bun-linux-x64` and installed at:

```text
/home/exedev/.local/bin/amp-acp
```

The adapter uses the existing authenticated Amp CLI at:

```text
/home/exedev/.local/bin/amp
```

No Amp API key or companion secret is copied into BB configuration.

### Approved Registry-Binary Exception

BB starts a fresh ACP subprocess when it resumes a later thread turn. The
unmodified Registry `amp-acp` 0.9.0 binary keeps ACP-session-to-Amp-thread
state only in process memory and neither advertises nor implements
`session/load`. The approved exception is a narrowly patched build from
upstream commit `68f0a16ebd437e51c9bf4d7a2b47c981010dc9a1`; its reproducible
source/test patch is
`integrations/amp-acp/patches/0001-bb-session-load.patch`. The original
Registry binary is retained as
`/home/exedev/.local/bin/amp-acp.registry-0.9.0`.

The patched adapter advertises `agentCapabilities.loadSession: true`. When the
first Amp stream yields a validated `T-...` thread ID, it atomically persists
only this minimal mapping:

```ts
type PersistedSession = {
  version: 1;
  sessionId: string;
  threadId: string;
};
```

On Linux the mapping is stored below
`${XDG_STATE_HOME:-$HOME/.local/state}/amp-acp/sessions`, with directory mode
`0700` and file mode `0600`. A later BB-created ACP process loads the exact
validated session, uses the load request's current cwd and MCP server list,
and continues the saved Amp thread. No prompts, responses, transcripts, MCP
configuration, credentials, or modes are persisted.

This is a BB-specific `session/load` resume shim, not a general ACP
load-history implementation. It restores only Amp execution context and
deliberately emits no historical `session/update` notifications: BB owns the
conversation timeline, and an adapter-side transcript mirror is prohibited.

## Architecture

The existing explicit handoff path remains unchanged:

```text
BB Amp panel
  -> bb-plugin-amp
  -> authenticated companion transport
  -> Amp Plugin API
  -> existing named Runner
```

The new native provider path is independent:

```text
BB thread
  -> BB ACP client
  -> amp-acp subprocess on exe.dev
  -> Amp CLI stream-json transport
  -> Amp thread in the BB environment cwd
```

The ACP adapter starts a transient Amp CLI subprocess for a prompt and keeps
the Amp thread ID for continuation. The durable minimal mapping is required
for continuation across BB's process-per-turn lifecycle. It does not start,
stop, rename, or target the existing `amp --no-tui` Runner.

## BB Configuration

Add one `customAcpAgents` entry to the BB server data-directory `config.json`:

```json
{
  "id": "amp",
  "displayName": "Amp (ACP)",
  "command": "/home/exedev/.local/bin/amp-acp",
  "env": {
    "AMP_CLI_PATH": "/home/exedev/.local/bin/amp"
  }
}
```

Preserve every existing config key and custom ACP entry. Refresh BB managed
configuration after the edit. BB exposes this agent as provider `acp-amp`.

Do not set `AMP_ACP_TRANSPORT=sdk`; the default CLI transport provides
streaming ACP updates. Do not set `AMP_ACP_CONTINUE_LATEST`; each new BB thread
must create its own Amp thread instead of attaching to an unrelated recent
thread.

## Workspace And Memory Behavior

BB supplies the ACP session cwd. Amp therefore runs in the actual BB
environment, including a BB managed worktree when one is selected. This path
does not use the fixed cwd of the named Runner.

BB agent instructions and enabled BB skills are resolved for the ACP provider
and included in the provider session. The BB Memory plugin's compact global
and current-project catalog is likewise contributed at thread start and turn
submission. Amp's own skills, plugins, and authentication remain owned by the
Amp CLI.

## Permissions And Security

- Keep the adapter's default permission mode for the first installation.
- Do not enable Amp's `dangerouslyAllowAll` mode in configuration.
- Do not expose a network listener; ACP uses JSON-RPC over subprocess stdio.
- Do not add an exe.dev proxy or public share.
- Do not alter the companion secret or Amp authentication.
- Preserve the existing Runner process and companion listener.

## Verification

1. Verify the downloaded archive against the ACP Registry SHA-256.
2. Run `amp-acp` through an ACP initialization probe without a prompt.
3. Refresh BB configuration and confirm `acp-amp` appears for the exe.dev
   machine.
4. Start an opt-in BB thread using `acp-amp` in `/home/exedev` with a prompt
   that forbids tool use and file changes.
5. Confirm the response streams into the BB thread and the Amp thread is
   visible on ampcode.com.
6. Confirm the existing Runner PID, Runner ID, and companion loopback listener
   are unchanged.
7. Confirm no workspace files changed during the smoke test.

## Failure And Rollback

If binary verification, ACP initialization, provider discovery, or the smoke
test fails, restore the verified Registry baseline with
`install -m 0755 /home/exedev/.local/bin/amp-acp.registry-0.9.0 /home/exedev/.local/bin/amp-acp`.
Do not remove or refresh the provider configuration, and do not restart or
modify the existing Amp Runner or companion.
