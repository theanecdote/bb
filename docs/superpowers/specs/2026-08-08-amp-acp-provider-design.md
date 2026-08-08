# Amp ACP Provider Design

## Objective

Expose Amp as a native BB ACP provider on the enrolled exe.dev machine while
preserving the existing `bb-plugin-amp` companion integration and the running
named Amp Runner.

## Source And Trust

Use `amp-acp` version 0.9.0 from the curated ACP Registry. The adapter is a
third-party project, not an Amp-owned component. Download the Registry's
Linux x64 binary distribution and verify its published SHA-256 before
installation.

Install the verified binary at:

```text
/home/exedev/.local/bin/amp-acp
```

The adapter uses the existing authenticated Amp CLI at:

```text
/home/exedev/.local/bin/amp
```

No Amp API key or companion secret is copied into BB configuration.

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
the Amp thread ID for continuation. It does not start, stop, rename, or target
the existing `amp --no-tui` Runner.

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
test fails, remove only the new `customAcpAgents` entry, refresh BB
configuration, and remove the installed `amp-acp` binary. Do not restart or
modify the existing Amp Runner or companion.
