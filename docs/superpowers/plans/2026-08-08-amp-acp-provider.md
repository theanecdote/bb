# Amp ACP Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the Registry-pinned Amp ACP adapter on the enrolled exe.dev machine, register it as BB provider `acp-amp`, and prove that a BB thread streams an Amp conversation from its selected BB workspace without disturbing the existing named Amp Runner or companion integration.

**Architecture:** BB launches `/home/exedev/.local/bin/amp-acp` as a per-thread ACP subprocess on the enrolled exe.dev host. The adapter uses the existing authenticated `/home/exedev/.local/bin/amp` CLI and ACP JSON-RPC over stdio, while the existing `bb-plugin-amp -> amp-plugin-bb-companion -> named Runner` handoff path remains independent and unchanged. BB supplies the thread environment cwd, so ACP Amp threads operate in the selected existing checkout or managed worktree rather than the fixed Runner cwd.

**Tech Stack:** BB custom ACP providers, Agent Client Protocol JSON-RPC over NDJSON stdio, `amp-acp` 0.9.0, Amp CLI `0.0.1786114290-g72b804`, exe.dev Linux x86_64, `sha256sum`, BB CLI, GitHub CLI.

## Global Constraints

- Use only `amp-acp` version `0.9.0` from the ACP Registry Linux x86_64 release archive.
- Require archive SHA-256 `afaa50a152eb86a8ff21e354ded63fe2d21b730859692e3a60b2c4c9ef23df31` before extraction or installation.
- Install the adapter only at `/home/exedev/.local/bin/amp-acp` with mode `0755`.
- Configure provider slug `amp`, which BB exposes as `acp-amp`, with `AMP_CLI_PATH=/home/exedev/.local/bin/amp`.
- Do not set `AMP_ACP_TRANSPORT`, `AMP_ACP_CONTINUE_LATEST`, or an Amp API key in BB configuration.
- Do not configure a fixed ACP cwd; BB must supply the selected thread workspace.
- Do not create an HTTP listener, exe.dev proxy, public share, VM, Runner, worktree, or orchestration service.
- Do not stop, restart, rename, or otherwise modify Runner `ice-by-snowboard` or its companion listener.
- Do not change `/home/exedev/.config/amp/bb-companion.json`, Amp authentication, or the existing BB Amp plugin configuration.
- Preserve every unrelated key and every pre-existing `customAcpAgents` entry in `/Users/morgan/.bb/config.json`.
- Never print the complete BB config, GitHub token, Amp credentials, or companion secret.
- Publish documentation only to `https://github.com/theanecdote/bb`; never open a PR against the upstream BB repository.

---

### Task 1: Verify and install the ACP Registry artifact

**Files:**
- Create: `/home/exedev/.local/bin/amp-acp`
- Reference: `docs/superpowers/specs/2026-08-08-amp-acp-provider-design.md`

**Interfaces:**
- Consumes: ACP Registry release `amp-acp` 0.9.0 for `linux-x86_64`; existing authenticated Amp CLI `/home/exedev/.local/bin/amp`.
- Produces: executable ACP stdio server `/home/exedev/.local/bin/amp-acp` whose initialization response identifies `amp-acp` and protocol version `1`.

- [ ] **Step 1: Capture the existing Runner and companion baseline without reading protected configuration**

Run:

```bash
test "$(tr '\0' ' ' </proc/4467/cmdline)" = "/home/exedev/.local/bin/amp --no-tui --runner-id ice-by-snowboard "
ps -p 4467 -o pid=,lstart=,args=
ss -ltnp '( sport = :43931 )' | tee /tmp/amp-acp-listener-before.txt
/home/exedev/.local/bin/amp --version
```

Expected: PID `4467` is the live `ice-by-snowboard` Runner, port `43931` is loopback-only and owned by an Amp process, and the CLI reports `0.0.1786114290-g72b804`. Stop this task if the PID or command no longer matches; rediscover the current Runner baseline without restarting it before continuing.

- [ ] **Step 2: Download the pinned archive into a private temporary directory**

Run:

```bash
install -d -m 700 /tmp/bb-amp-acp-0.9.0
curl --fail --location --proto '=https' --tlsv1.2 \
  --output /tmp/bb-amp-acp-0.9.0/amp-acp-linux-x86_64.tar.gz \
  https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-linux-x86_64.tar.gz
```

Expected: `curl` exits `0` and creates a non-empty archive. Do not extract it yet.

- [ ] **Step 3: Reject any archive that does not match the ACP Registry checksum**

Run:

```bash
printf '%s  %s\n' \
  afaa50a152eb86a8ff21e354ded63fe2d21b730859692e3a60b2c4c9ef23df31 \
  /tmp/bb-amp-acp-0.9.0/amp-acp-linux-x86_64.tar.gz \
  | sha256sum --check --strict
```

Expected: `amp-acp-linux-x86_64.tar.gz: OK`. On any mismatch, stop without extracting or installing the archive.

- [ ] **Step 4: Inspect the archive and install only its adapter executable**

Run:

```bash
tar -tzf /tmp/bb-amp-acp-0.9.0/amp-acp-linux-x86_64.tar.gz
tar -xzf /tmp/bb-amp-acp-0.9.0/amp-acp-linux-x86_64.tar.gz \
  -C /tmp/bb-amp-acp-0.9.0
find /tmp/bb-amp-acp-0.9.0 -maxdepth 2 -type f -name 'amp-acp*' -print
install -D -m 0755 \
  /tmp/bb-amp-acp-0.9.0/amp-acp \
  /home/exedev/.local/bin/amp-acp
test "$(stat -c '%a' /home/exedev/.local/bin/amp-acp)" = 755
```

Expected: the archive lists the single executable `amp-acp`, the installed path is executable, and its numeric mode is `755`.

- [ ] **Step 5: Probe ACP initialization without creating an Amp thread**

Run:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | timeout 10 env AMP_CLI_PATH=/home/exedev/.local/bin/amp \
      /home/exedev/.local/bin/amp-acp \
  | tee /tmp/amp-acp-initialize.jsonl
jq -e 'select(.id == 1) | .result.protocolVersion == 1 and .result.agentInfo.name == "amp-acp"' \
  /tmp/amp-acp-initialize.jsonl
```

Expected: `jq` exits `0`. This sends only ACP `initialize`; it must not call `session/new` or `session/prompt`, so no Amp thread is created.

### Task 2: Register `acp-amp` in the BB server configuration

**Files:**
- Modify on BB server host: `/Users/morgan/.bb/config.json`

**Interfaces:**
- Consumes: installed `/home/exedev/.local/bin/amp-acp`; connected BB host `host_c6pj9rqivr` (`ice-by-snowboard`).
- Produces: BB custom provider `acp-amp` with display name `Amp (ACP)` and an ACP launch spec that executes on the selected enrolled host.

- [ ] **Step 1: Delegate the server-local config edit to the connected BB server host**

Run from this exe.dev thread:

```bash
CONFIG_THREAD_JSON=$(bb thread spawn --json \
  --project proj_f2s6c423wk \
  --machine host_3wuzxjcdtz \
  --provider codex \
  --permission-mode full \
  --title 'Register Amp ACP provider' \
  --prompt 'Edit /Users/morgan/.bb/config.json on this host. Preserve every existing key and every existing customAcpAgents entry. Add or replace only the entry whose id is amp with exactly: {"id":"amp","displayName":"Amp (ACP)","command":"/home/exedev/.local/bin/amp-acp","env":{"AMP_CLI_PATH":"/home/exedev/.local/bin/amp"}}. Do not add cwd, args, AMP_ACP_TRANSPORT, AMP_ACP_CONTINUE_LATEST, credentials, or secrets. Validate the resulting JSON, run npx bb-app config refresh, and report only whether refresh succeeded plus the custom ACP ids; do not print the complete config or any secret values.')
CONFIG_THREAD_ID=$(printf '%s' "$CONFIG_THREAD_JSON" | jq -r '.id')
test -n "$CONFIG_THREAD_ID" && test "$CONFIG_THREAD_ID" != null
bb thread wait "$CONFIG_THREAD_ID" --status idle --timeout 1200
bb thread output "$CONFIG_THREAD_ID"
```

Expected: the remote worker reports valid JSON, successful `npx bb-app config refresh`, and an `amp` custom ACP id without exposing the complete config.

- [ ] **Step 2: Verify provider discovery specifically on the exe.dev execution host**

Run:

```bash
bb provider list --machine host_c6pj9rqivr --json \
  | jq -e '.[] | select(.id == "acp-amp" and .displayName == "Amp (ACP)" and .available == true)'
```

Expected: exactly one available provider record for `acp-amp`. If it is absent, inspect only the remote worker output and BB managed-config diagnostics; do not restart Amp or alter the Runner.

- [ ] **Step 3: Verify the existing companion path still responds as an authenticated loopback API**

Run:

```bash
STATUS=$(curl --silent --output /tmp/bb-companion-unauthorized.json \
  --write-out '%{http_code}' \
  http://127.0.0.1:43931/v1/threads/T-019fdcbe-5b4b-71a8-a35d-f560f8478a8d)
test "$STATUS" = 401
jq -e '.code == "UNAUTHORIZED"' /tmp/bb-companion-unauthorized.json
```

Expected: HTTP `401` with typed JSON code `UNAUTHORIZED`. This verifies listener/API shape without reading or transmitting the companion secret.

### Task 3: Run the native BB-to-Amp ACP smoke test

**Files:**
- Read only: `/home/exedev/theanecdote-bb`
- Read only: `/proc/4467/cmdline`
- Read only: `/tmp/amp-acp-listener-before.txt`

**Interfaces:**
- Consumes: BB provider `acp-amp`, unmanaged BB environment path `/home/exedev/theanecdote-bb`, adapter default CLI streaming transport.
- Produces: one BB thread backed by one new Amp thread, with assistant output streamed into BB and no workspace edits.

- [ ] **Step 1: Snapshot the checkout's clean Git state**

Run:

```bash
git -C /home/exedev/theanecdote-bb status --porcelain=v1 \
  > /tmp/amp-acp-workspace-before.txt
test ! -s /tmp/amp-acp-workspace-before.txt
```

Expected: the repository is clean before the smoke test. If it is not clean, stop and preserve the unrelated changes; do not stash, reset, or discard them.

- [ ] **Step 2: Spawn an explicit ACP Amp thread in the existing BB environment**

Run:

```bash
SMOKE_THREAD_JSON=$(bb thread spawn --json \
  --project proj_f2s6c423wk \
  --environment /home/exedev/theanecdote-bb \
  --provider acp-amp \
  --permission-mode accept-edits \
  --title 'Amp ACP transport smoke test' \
  --prompt 'ACP transport smoke test only. Do not call tools, inspect files, or modify files. Reply exactly: AMP ACP READY')
SMOKE_THREAD_ID=$(printf '%s' "$SMOKE_THREAD_JSON" | jq -r '.id')
test -n "$SMOKE_THREAD_ID" && test "$SMOKE_THREAD_ID" != null
bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 1200
```

Expected: BB creates one thread with provider `acp-amp`, and it reaches `idle` without a permission interaction or provider failure.

- [ ] **Step 3: Verify streamed conversation output and provider identity**

Run:

```bash
test "$(bb thread output "$SMOKE_THREAD_ID" | tr -d '\r' | sed -e 's/[[:space:]]*$//')" = 'AMP ACP READY'
bb thread show "$SMOKE_THREAD_ID" --json \
  | jq -e '.thread.providerId == "acp-amp" and .environment.path == "/home/exedev/theanecdote-bb"'
bb thread log "$SMOKE_THREAD_ID" --json \
  | jq -e '[.[] | select(.type == "item/agentMessage/delta" or .type == "item/completed")] | length > 0'
```

Expected: final output is exactly `AMP ACP READY`, the thread is bound to `acp-amp` and the requested environment, and the event log contains assistant/turn completion events rendered by BB's native conversation surface. If the installed BB version emits different public event names, use `bb thread log` to verify visible streamed assistant content and record the observed public names; do not inspect adapter internals or mirror an Amp transcript.

- [ ] **Step 4: Confirm the Amp thread is visible in Amp**

Open ampcode.com and locate the newly created thread by its content `AMP ACP READY` and creation time.

Expected: exactly one new Amp thread corresponds to the BB smoke invocation. Do not send a second smoke prompt as a discovery mechanism.

- [ ] **Step 5: Prove the existing Runner and companion were not disturbed**

Run:

```bash
test "$(tr '\0' ' ' </proc/4467/cmdline)" = "/home/exedev/.local/bin/amp --no-tui --runner-id ice-by-snowboard "
ps -p 4467 -o pid=,lstart=,args=
ss -ltnp '( sport = :43931 )' | tee /tmp/amp-acp-listener-after.txt
diff -u /tmp/amp-acp-listener-before.txt /tmp/amp-acp-listener-after.txt
git -C /home/exedev/theanecdote-bb status --porcelain=v1 \
  > /tmp/amp-acp-workspace-after.txt
diff -u /tmp/amp-acp-workspace-before.txt /tmp/amp-acp-workspace-after.txt
```

Expected: Runner PID `4467`, Runner ID `ice-by-snowboard`, and loopback listener ownership are unchanged, and the smoke prompt made no repository changes. The probe files remain under `/tmp`, outside the repository.

- [ ] **Step 6: Verify same-session conversation continuity with one follow-up**

Run:

```bash
bb thread tell "$SMOKE_THREAD_ID" 'Do not call tools or modify files. Reply exactly: AMP ACP CONTINUED'
bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 1200
test "$(bb thread output "$SMOKE_THREAD_ID" | tr -d '\r' | sed -e 's/[[:space:]]*$//')" = 'AMP ACP CONTINUED'
```

Expected: the same BB thread returns `AMP ACP CONTINUED`; amp-acp continues the same Amp session rather than creating a replacement BB thread.

### Task 4: Publish the approved design and plan to the personal fork

**Files:**
- Existing: `docs/superpowers/specs/2026-08-08-amp-acp-provider-design.md`
- Existing: `docs/superpowers/plans/2026-08-08-amp-acp-provider.md`

**Interfaces:**
- Consumes: verified runtime installation and the local documentation commits on branch `docs/amp-acp-provider`.
- Produces: a merged PR in `theanecdote/bb` only.

- [ ] **Step 1: Re-run documentation and repository checks**

Run:

```bash
git diff --check origin/main...HEAD
if rg -n '[T]ODO|[T]BD|[f]ill in details|[i]mplement later' \
  docs/superpowers/specs/2026-08-08-amp-acp-provider-design.md \
  docs/superpowers/plans/2026-08-08-amp-acp-provider.md; then
  exit 1
fi
git status --short --branch
git remote get-url origin
```

Expected: `git diff --check` passes, the placeholder scan has no matches, the branch contains only the intended docs changes, and `origin` is `https://github.com/theanecdote/bb` (or the SSH equivalent for that same repository).

- [ ] **Step 2: Commit any uncommitted plan document**

Run:

```bash
git add docs/superpowers/plans/2026-08-08-amp-acp-provider.md
git commit -m 'Document Amp ACP provider implementation plan'
```

Expected: one commit containing only the plan document. If the plan is already committed by the planning session, verify `git status --short` is clean and skip creating an empty commit.

- [ ] **Step 3: Push the documentation branch only to the personal fork**

Run:

```bash
test "$(git remote get-url origin)" = 'https://github.com/theanecdote/bb.git' \
  || test "$(git remote get-url origin)" = 'git@github.com:theanecdote/bb.git'
git push --set-upstream origin docs/amp-acp-provider
```

Expected: branch `docs/amp-acp-provider` is published to `theanecdote/bb`. Do not use any other remote.

- [ ] **Step 4: Open and merge the PR in `theanecdote/bb`**

Run:

```bash
PR_URL=$(gh pr create \
  --repo theanecdote/bb \
  --base main \
  --head docs/amp-acp-provider \
  --title 'Document native Amp ACP provider setup' \
  --body 'Documents the approved ACP provider architecture and the verified installation, configuration, smoke-test, invariants, rollback, and personal-fork-only publication procedure.')
gh pr checks --repo theanecdote/bb "$PR_URL" --watch
gh pr merge --repo theanecdote/bb "$PR_URL" --merge --delete-branch
gh pr view --repo theanecdote/bb "$PR_URL" --json state,mergedAt,url \
  | jq -e '.state == "MERGED" and .mergedAt != null'
```

Expected: checks pass and the PR state is `MERGED` in `theanecdote/bb`. No PR is created against `get-bb/bb` or any other upstream repository.

## Rollback

If ACP initialization or the smoke test fails after configuration, remove only the `customAcpAgents` entry with `id: "amp"` from `/Users/morgan/.bb/config.json`, preserve all other config, run `npx bb-app config refresh` on the BB server host, and remove `/home/exedev/.local/bin/amp-acp`. Do not restart Amp, terminate PID `4467`, remove the companion plugin, or alter its secret/listener.
