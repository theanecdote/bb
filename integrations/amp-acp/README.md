# Patched Amp ACP Binary

This directory records the approved, narrowly patched exception to the
Registry `amp-acp` 0.9.0 binary. The first patch adds durable ACP `session/load`
support required because BB starts a fresh ACP subprocess for later turns.
It persists only `{ version, sessionId, threadId }`, allowing the new process
to invoke `amp threads continue <threadId>` without storing prompts,
responses, MCP configuration, credentials, or transcripts.

This is a BB-specific resume shim, not a general ACP load-history
implementation. It restores Amp execution context only and deliberately emits
no historical `session/update` notifications. BB already owns the conversation
timeline and does not require an adapter-side transcript mirror.

- Upstream: `https://github.com/tao12345666333/amp-acp`
- Source commit: `68f0a16ebd437e51c9bf4d7a2b47c981010dc9a1`
- Registry archive: `amp-acp` 0.9.0 Linux x86_64
- Registry archive SHA-256: `afaa50a152eb86a8ff21e354ded63fe2d21b730859692e3a60b2c4c9ef23df31`
- Patch: `patches/0001-bb-session-load.patch`
- Patch: `patches/0002-amp-mode-executor.patch`

The second patch exposes each Amp mode with an explicit executor: `Machine`
uses the external SDK's `local` executor in the selected BB environment, while
`Orb` uses the SDK's `orb` executor. The executor is supplied only when creating
a thread. Continued Amp threads retain their original executor and never switch
silently. This ACP path does not target named live Runners; named Runner handoff
remains the companion plugin's stable Amp Plugin API responsibility.

Build from a clean clone at the listed source commit:

```bash
git apply --unidiff-zero /home/exedev/theanecdote-bb/integrations/amp-acp/patches/0001-bb-session-load.patch
git apply --unidiff-zero /home/exedev/theanecdote-bb/integrations/amp-acp/patches/0002-amp-mode-executor.patch
npx --yes bun@1.2.20 install
npx --yes bun@1.2.20 build src/index.ts --compile --target=bun-linux-x64 --outfile dist/amp-acp
```

Install the patched `dist/amp-acp` at `/home/exedev/.local/bin/amp-acp` with
mode `0755`. The Registry binary is used only as the verified baseline and is
retained at `/home/exedev/.local/bin/amp-acp.registry-0.9.0` for rollback.

On Linux, minimal mappings live at
`${XDG_STATE_HOME:-$HOME/.local/state}/amp-acp/sessions`. The directory is
mode `0700`; each JSON mapping is mode `0600` and is written atomically by
same-directory temporary file plus rename.

To roll back the executable without changing BB configuration, Amp CLI,
Runner, or companion:

```bash
install -m 0755 /home/exedev/.local/bin/amp-acp.registry-0.9.0 \
  /home/exedev/.local/bin/amp-acp
```
