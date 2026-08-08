# Patched Amp ACP Binary

This directory records the approved, narrowly patched exception to the
Registry `amp-acp` 0.9.0 binary. The patch adds durable ACP `session/load`
support required because BB starts a fresh ACP subprocess for later turns.
It persists only `{ version, sessionId, threadId }`, allowing the new process
to invoke `amp threads continue <threadId>` without storing prompts,
responses, MCP configuration, credentials, or transcripts.

- Upstream: `https://github.com/tao12345666333/amp-acp`
- Source commit: `68f0a16ebd437e51c9bf4d7a2b47c981010dc9a1`
- Registry archive: `amp-acp` 0.9.0 Linux x86_64
- Registry archive SHA-256: `afaa50a152eb86a8ff21e354ded63fe2d21b730859692e3a60b2c4c9ef23df31`
- Patch: `patches/0001-bb-session-load.patch`

Build from a clean clone at the listed source commit:

```bash
git apply --unidiff-zero /home/exedev/theanecdote-bb/integrations/amp-acp/patches/0001-bb-session-load.patch
npx --yes bun@1.2.20 install
npx --yes bun@1.2.20 build src/index.ts --compile --target=bun-linux-x64 --outfile dist/amp-acp
```

Install `dist/amp-acp` at `/home/exedev/.local/bin/amp-acp` with mode `0755`.
The verified Registry binary is retained at
`/home/exedev/.local/bin/amp-acp.registry-0.9.0` for rollback.

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
