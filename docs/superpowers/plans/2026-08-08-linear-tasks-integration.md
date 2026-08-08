# Linear Integration for BB Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project every incomplete Linear issue assigned to the authenticated user into native BB Tasks and write supported BB task edits back to Linear.

**Architecture:** Extend the existing `tasks` plugin in place. A small raw-GraphQL client owns Linear transport, a sync service owns mappings and projection, and a shared task mutation hook sends mapped task changes upstream before local commit. The current Tasks RPC, CLI, delegation, realtime, and UI surfaces remain authoritative for BB behavior.

**Tech Stack:** TypeScript, BB Plugin SDK 0.4.1, `fetch`, Linear GraphQL API, better-sqlite3, Zod 4, React 19, Vitest 4, Testing Library.

## Global Constraints

- Linear is authoritative for mapped issue fields.
- Import all non-archived, incomplete issues assigned to Linear `viewer`.
- Preserve Linear keys exactly (`PER-2165` remains `PER-2165`).
- Treat mapped Tasks projects as import-only; local task creation is refused.
- Store `linearApiKey` only as a BB secret setting; never log or return it.
- Use the existing Tasks `MIGRATIONS` array; do not add another migration mechanism.
- Update task rows only when projected values changed.
- Write status, title, description, priority, and due-date changes to Linear before local commit.
- Write only `kind = user` comments to Linear; agent and system comments remain local.
- Keep labels and sub-tasks local; reject attachments on mapped tasks.
- Use initial plus five-minute polling; do not expose a webhook endpoint.
- Await Linear network work outside synchronous better-sqlite3 transactions.
- Use Turbo for full test, typecheck, and build runs; focused Vitest files are the only deliberate orchestration bypass.
- Publish and install only from `https://github.com/theanecdote/bb`; never open an upstream PR.

---

### Task 0: Make Tasks Runtime Plugin-ID Agnostic

**Files:**
- Modify: `plugins/tasks/server.ts`
- Modify: `plugins/tasks/shared/contract.ts`
- Modify: `plugins/tasks/attachments/index.ts`
- Modify: `plugins/tasks/views/detail/index.tsx`
- Modify: `plugins/tasks/views/detail/attachments.tsx`
- Modify: `plugins/tasks/attachments/attachments.test.ts`
- Modify: `plugins/tasks/delegate/delegate.test.ts`
- Modify: `plugins/tasks/cli/cli.test.ts`

**Interfaces:**
- Adds RPC `pluginTransport: null -> { pluginId: string; attachmentBaseUrl: string; tokenUrl: string }`.
- Uses `bb.pluginId` for backend HTTP paths; spawn attribution is already host-derived from the runtime plugin ID.
- Preserves the registered CLI command name `tasks` independently of plugin ID.
- The RPC is required because public frontend `BbContext` exposes only project and thread IDs, not the owning plugin ID.

- [ ] **Step 1: Write alternate-ID tests**

Run the plugin host as `tasks-linear`. Assert attachment URLs use
`/api/v1/plugins/tasks-linear`, the delegation harness observes its configured
runtime plugin ID, the nav/RPC surfaces load, and the CLI command is still
`bb tasks`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts attachments/attachments.test.ts delegate/delegate.test.ts cli/cli.test.ts`

Expected: FAIL on hard-coded `tasks` paths or attribution.

- [ ] **Step 3: Implement runtime identity plumbing**

Build transport URLs from `bb.pluginId` in the backend and return only safe
paths through `pluginTransport`; keep token retrieval on the existing local
token endpoint. Replace the hard-coded download and token paths plus upload URL
in `views/detail/attachments.tsx`, and the hard-coded `buildAttachmentUrl` path
in `attachments/index.ts`, with those runtime values. Pass transport values
through the detail view into frontend attachment functions. Spawn attribution
already uses `args.originPluginId ?? pluginId`, so make no production delegation
change; update the test expectation to use the harness plugin ID. Record that
persisted attachment URLs bind content to the plugin ID, so `tasks-linear` must
not be renamed again after use.

- [ ] **Step 4: Run focused tests and commit**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts attachments/attachments.test.ts delegate/delegate.test.ts cli/cli.test.ts`

```bash
git add plugins/tasks
git commit -m "Make Tasks plugin identity portable"
```

### Task 1: Linear GraphQL Client

**Files:**
- Create: `plugins/tasks/linear/client.ts`
- Create: `plugins/tasks/linear/client.test.ts`
- Create: `plugins/tasks/linear/types.ts`

**Interfaces:**
- Produces: `createLinearClient(options): LinearClient`.
- Produces: `LinearClient.viewerAssignedIssues()`, `issuesByIds(ids)`, `teamStates(teamId)`, `updateIssue(id, input)`, and `createComment(issueId, body)`.
- Produces: `LinearApiError` with code `LINEAR_RATE_LIMITED | LINEAR_API_ERROR` and a frontend-safe message.

- [ ] **Step 1: Write transport tests with a fake `fetch`**

Cover personal-key `Authorization`, JSON content type, a 10-second abort timeout, HTTP 401, HTTP 429, HTTP 5xx, malformed JSON, GraphQL `errors` on HTTP 200, and responses containing both `data` and `errors`. Assert no thrown error contains the API key or GraphQL variables. For 429, assert `Retry-After` and Linear reset headers are parsed into a safe `retryAt` timestamp.

```ts
const client = createLinearClient({
  apiKey: "lin_api_secret",
  fetch: fakeFetch,
  timeoutMs: 10_000,
});
await expect(client.viewerAssignedIssues()).rejects.toMatchObject({
  code: "LINEAR_API_ERROR",
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts linear/client.test.ts`

Expected: FAIL because `linear/client.ts` does not exist.

- [ ] **Step 3: Implement bounded GraphQL transport and schemas**

Use operation names and variables, never string interpolation. Parse every response with Zod. Treat any non-empty GraphQL `errors` array as a complete failure. Map `429` to `LINEAR_RATE_LIMITED` with `retryAt`; map authentication, timeout, protocol, and GraphQL failures to `LINEAR_API_ERROR` with safe messages. `issuesByIds` uses `includeArchived: true` and returns `archivedAt`, `assignee.id`, `team.id/key`, and `state.id/type/position`. The active viewer query keeps archived resources excluded.

```ts
export interface LinearClient {
  viewerAssignedIssues(signal?: AbortSignal): Promise<LinearAssignedSnapshot>;
  issuesByIds(ids: readonly string[], signal?: AbortSignal): Promise<LinearIssue[]>;
  teamStates(teamId: string, signal?: AbortSignal): Promise<LinearWorkflowState[]>;
  updateIssue(id: string, input: LinearIssueUpdate, signal?: AbortSignal): Promise<LinearIssue>;
  createComment(issueId: string, body: string, signal?: AbortSignal): Promise<{ id: string }>;
}
```

- [ ] **Step 4: Add Relay pagination and batch tests**

Assert assigned issues follow `pageInfo.endCursor` until `hasNextPage` is false, reject more than 100 pages or 10,000 issues, and split `issuesByIds` into batches of 50.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts linear/client.test.ts`

Run: `pnpm exec turbo run typecheck --filter=bb-plugin-tasks`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/tasks/linear/client.ts plugins/tasks/linear/client.test.ts plugins/tasks/linear/types.ts
git commit -m "Add bounded Linear GraphQL client"
```

### Task 2: Linear Mapping Schema and Store

**Files:**
- Modify: `plugins/tasks/db/schema.ts`
- Modify: `plugins/tasks/db/store.ts`
- Modify: `plugins/tasks/db/types.ts`
- Modify: `plugins/tasks/db.test.ts`
- Create: `plugins/tasks/linear/store.ts`
- Create: `plugins/tasks/linear/store.test.ts`

**Interfaces:**
- Produces: `LinearMappingStore` with team mapping, issue mapping, active marker, state ID, URL, identifier, remote timestamp, and sync-state methods.
- Extends: `TasksStore.createTask` with optional explicit `number` and safe `next_task_number` advancement.
- Produces: `TasksStore.updateTaskIfChanged` returning `{ task, changed }`.
- Produces: `LinearMappingStore.isMappedProject(projectId)` for import-only enforcement.

- [ ] **Step 1: Write migration and identity tests**

Append one migration that creates `linear_team_projects`, `linear_issue_tasks`, and singleton `linear_sync_state`. Add uniqueness and cascading foreign keys for Linear team ID, issue ID, task ID, and Tasks project ID.

Assert an explicit imported task number creates `PER-2165`, advances `next_task_number` to at least 2166, and a second import of the same issue returns its existing mapping. Assert the mapping store distinguishes mapped and unmapped projects; Task 4 applies the domain-level creation refusal.

- [ ] **Step 2: Run DB tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts db.test.ts linear/store.test.ts`

Expected: FAIL because the migration and store methods are absent.

- [ ] **Step 3: Implement the migration and mapping store**

```ts
export interface LinearIssueMapping {
  linearIssueId: string;
  taskId: string;
  identifier: string;
  url: string;
  linearStateId: string;
  linearUpdatedAt: string;
  active: boolean;
}
```

Use prepared statements inside `createLinearMappingStore(db)`. Keep mapping writes within the caller's Tasks transaction. Do not store descriptions, comments, or credentials in mapping tables.

- [ ] **Step 4: Implement change-aware task updates**

Compare normalized values before issuing SQL `UPDATE`. Assert a no-op update leaves `task_list_revision.revision` unchanged and a real update increments it once.

- [ ] **Step 5: Run DB and mapping tests**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts db.test.ts linear/store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/tasks/db plugins/tasks/linear/store.ts plugins/tasks/linear/store.test.ts
git commit -m "Add durable Linear task mappings"
```

### Task 3: Projection and Reconciliation Service

**Files:**
- Create: `plugins/tasks/linear/sync.ts`
- Create: `plugins/tasks/linear/sync.test.ts`
- Modify: `plugins/tasks/api/index.ts`

**Interfaces:**
- Consumes: `LinearClient`, `LinearMappingStore`, and `TasksApiStore`.
- Produces: `createLinearSyncService(deps): LinearSyncService`.
- Produces: `sync(): Promise<LinearSyncResult>` with single-flight behavior.
- Produces: `getStatus(): LinearSyncStatus`.

- [ ] **Step 1: Write mapping and idempotency tests**

Cover priority, due date, `triage/backlog/unstarted/started/completed/canceled/duplicate` workflow types, unknown-state fallback with one log per state ID, team project creation, exact identifier number, duplicate sync, changed-field refresh, and no-op revision preservation. Verify a pre-existing unmapped project with the same team prefix or a team key outside `PROJECT_PREFIX_PATTERN` yields `LINEAR_MAPPING_ERROR` without importing partial team data.

- [ ] **Step 2: Run sync tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts linear/sync.test.ts`

Expected: FAIL because `createLinearSyncService` is absent.

- [ ] **Step 3: Implement active projection transaction**

For each complete assigned snapshot, group by Linear team, validate every prefix before mutations, create/reuse mapped projects with `DEFAULT_COLOR` from `views/manage/shared.tsx`, create/reuse tasks, update only changed fields, and update mapping state in the same transaction. If remote `updatedAt` is unchanged, skip projection but refresh mapping liveness. Never overwrite a user-changed project color. Publish `projects:changed` and `tasks:changed` only for actual changes.

- [ ] **Step 4: Write reconciliation tests**

Cover missing mapped IDs fetched with archived resources included and apply precedence: completed becomes `done`; canceled or duplicate becomes `canceled`; only then unassigned/archived becomes inactive without local status mutation. A completed+archived issue becomes `done`. Later reassignment reactivates the same task. A cross-team move inactivates the old mapping and imports a new task under the new team while preserving the old task. Assert failed or partial active fetch performs no reconciliation.

- [ ] **Step 5: Implement state-ID merge semantics**

If remote `state.id` equals stored `linearStateId`, preserve local `in_review`. If it differs, map the new remote workflow type and update both local status and stored state ID.

- [ ] **Step 6: Add single-flight and failure-state tests**

Two concurrent `sync()` calls must return the same promise and execute one active query. Failed sync stores a safe error and leaves `lastSuccessfulSyncAt` and task rows untouched.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts linear/sync.test.ts`

```bash
git add plugins/tasks/linear/sync.ts plugins/tasks/linear/sync.test.ts plugins/tasks/api/index.ts
git commit -m "Project assigned Linear issues into Tasks"
```

### Task 4: Shared Outbound Mutation Boundary

**Files:**
- Create: `plugins/tasks/linear/mutations.ts`
- Create: `plugins/tasks/linear/mutations.test.ts`
- Modify: `plugins/tasks/api/index.ts`
- Modify: `plugins/tasks/delegate/index.ts`
- Modify: `plugins/tasks/attachments/index.ts`
- Modify: `plugins/tasks/server.ts`
- Modify: `plugins/tasks/views/detail/description-save.ts`
- Modify: `plugins/tasks/views/detail/index.tsx`
- Modify: `plugins/tasks/cli/cli.test.ts`
- Modify: `plugins/tasks/delegate/delegate.test.ts`
- Modify: `plugins/tasks/attachments/attachments.test.ts`

**Interfaces:**
- Produces: `LinearMutationBridge.prepareTaskMutation(current, patch, origin): Promise<TaskMutationCommit>`; callers await preparation outside a transaction and invoke its synchronous `commit(store)` inside the local transaction.
- Produces: the same two-phase shape for `prepareUserComment`.
- Produces: `LinearMutationBridge.assertAttachmentAllowed(taskId)`.
- Produces: `TaskMutationOrigin = "user" | "cli" | "delegation" | "agent" | "linear-sync"`; only `linear-sync` bypasses outbound Linear mutation.
- Changes: API `updateTask` and `boardMove` handlers become async and invoke the bridge before local mutation.

- [ ] **Step 1: Write status and editable-field mutation tests**

Cover RPC update, board move, CLI update, delegation `todo -> in_progress`, and agent CLI `in_review`. Assert `issueUpdate` succeeds before the local transaction and a rejected Linear mutation leaves BB unchanged. Assert mapped delegation never returns a promise from `store.transaction`; when Linear rejects after thread spawn, the thread remains attached and local status stays unchanged with a safe mapping error. Assert ten edits inside the mapped ten-second description window produce one RPC/Linear update, blur flushes immediately, and failure does not retry at 800 ms.

- [ ] **Step 2: Run mutation tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts linear/mutations.test.ts cli/cli.test.ts delegate/delegate.test.ts`

Expected: FAIL because direct write paths bypass the bridge.

- [ ] **Step 3: Implement workflow-state resolution and issue updates**

Cache each team's workflow states for one sync interval. Map BB statuses by Linear workflow type; resolve `in_review` by case-insensitive exact name first, then lowest `position` and ID among started states. On success, return a synchronous mapping-state commit. `parentTaskId` and `labelIds` remain local and are never forwarded or blocked. In the detail saver, use a ten-second debounce for mapped descriptions, preserve 800 ms for unmapped tasks, flush mapped drafts on blur/unmount, and do not retry failed mapped saves sooner than ten seconds.

- [ ] **Step 4: Route direct status paths through the bridge**

Update API edit and board handlers plus delegation's automatic transition. Preserve system comments and realtime notifications after successful local commit. Add regression tests enumerating `store.tasks.updateTask`, `store.tasks.updatePosition`, and `store.tasks.createTask`. Cover `api/index.ts` update, board `updatePosition`, delegation, attachment description rewrite, and mapped-project task creation. CLI update/comment already use shared handlers and need no duplicate bridge.

Inbound projection calls the same domain mutation boundary with origin
`linear-sync`; that origin applies the change-aware local update without
echoing an `issueUpdate` mutation back to Linear.

- [ ] **Step 5: Implement user-comment and attachment policy**

Prepare `commentCreate` before storing mapped `kind = user` comments. Do not call it for `agent` or `system`. Reject task and comment attachments on mapped tasks before writing a blob or modifying description. Reject a mapped user comment body containing a BB attachment URL. Leave unmapped attachment behavior unchanged.

- [ ] **Step 6: Run mutation, CLI, delegation, and attachment tests**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts linear/mutations.test.ts cli/cli.test.ts delegate/delegate.test.ts attachments/attachments.test.ts views/detail/description-save.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/tasks/api plugins/tasks/linear/mutations.ts plugins/tasks/linear/mutations.test.ts plugins/tasks/delegate plugins/tasks/attachments plugins/tasks/cli/cli.test.ts plugins/tasks/server.ts plugins/tasks/views/detail
git commit -m "Write mapped task changes back to Linear"
```

### Task 5: Settings, RPC, and Background Lifecycle

**Files:**
- Create: `plugins/tasks/linear/index.ts`
- Create: `plugins/tasks/linear/index.test.ts`
- Modify: `plugins/tasks/server.ts`
- Modify: `plugins/tasks/server.test.ts`
- Modify: `plugins/tasks/shared/contract.ts`
- Modify: `plugins/tasks/shell/data.ts`
- Create: `plugins/tasks/shell/data.test.ts`

**Interfaces:**
- Adds secret setting `linearApiKey`.
- Adds RPC `linearStatus: null -> LinearSyncStatus`.
- Adds RPC `linearSyncNow: null -> LinearSyncResult`.
- Publishes realtime channel `linear:changed`.
- Registers background service `linear-sync`.

- [ ] **Step 1: Write plugin-host registration tests**

Assert the secret descriptor is registered with `secret: true`, RPC output never contains the key, missing/unauthorized credentials call `bb.status.needsConfiguration`, and configured startup registers one abortable background service. Assert an ordinary rejected sync is caught, the next tick still runs, and the exact existing server log assertion is updated intentionally rather than hidden by extra load-time logging.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts server.test.ts linear/index.test.ts`

Expected: FAIL because Linear settings and RPC methods are absent.

- [ ] **Step 3: Implement lifecycle registration**

Create the client/service lazily from `settings.get()`. Register `settings.onChange` to discard the cached client so key rotation affects the next operation. The abort-aware loop wraps ordinary `sync()` errors, records/logs them safely, waits five minutes, and continues; only missing/rejected credentials throw `NeedsConfigurationError`. Manual/background calls share one promise. A rate-limit `retryAt` suppresses scheduled sync until that instant and appears in status.

- [ ] **Step 4: Extend the strict RPC contract and frontend hooks**

Add Zod schemas for configured state, viewer name, active issue count, last success, safe error, retry time, sync counts, and mapping source metadata. Extend task-domain error codes with `linear_write_failed`, `linear_rate_limited`, `linear_mapping_error`, and `linear_project_readonly`; bridge failures return typed mutation results. Add `linearSource: { identifier, url } | null` to strict task schemas, resolved by one batched mapping query per task page rather than N+1; assert a 100-task page performs one mapping query. Add `linear:changed` to `INVALIDATION_CHANNELS` and a matching `useRealtime` subscription, then add `useLinearStatus()`.

- [ ] **Step 5: Make frontend full-list pagination restart-safe**

Update `listAllTasks` to restart from a cursor-less request on typed
`stale_cursor`, bounded to three attempts. Test a revision bump between pages
returns one clean complete list without an infinite retry.

- [ ] **Step 6: Run server tests and typecheck**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts server.test.ts linear/index.test.ts shell/data.test.ts`

Run: `pnpm exec turbo run typecheck --filter=bb-plugin-tasks`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/tasks/server.ts plugins/tasks/server.test.ts plugins/tasks/shared/contract.ts plugins/tasks/shell/data.ts plugins/tasks/shell/data.test.ts plugins/tasks/linear/index.ts plugins/tasks/linear/index.test.ts
git commit -m "Register Linear sync lifecycle"
```

### Task 5b: CLI and Discoverable Surfaces

**Files:**
- Modify: `plugins/tasks/cli/index.ts`
- Modify: `plugins/tasks/cli/cli.test.ts`
- Modify: `plugins/tasks/skills/tasks/SKILL.md`
- Modify: `docs/configuration.md`
- Modify: `packages/templates/src/templates/bb-guide-plugins.md`
- Modify: `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md`

**Interfaces:**
- Adds `bb tasks linear status [--json]`.
- Adds `bb tasks linear sync [--json]`.
- Neither command accepts or prints a credential.

- [ ] **Step 1: Write CLI tests**

Assert human and JSON status output, manual sync output, safe typed failures,
and rejection of unknown/key-like arguments.

- [ ] **Step 2: Implement commands using the same service handlers as RPC**

Register both under the existing `tasks` CLI registration. Do not duplicate
sync logic in the CLI parser.

- [ ] **Step 3: Update skill and configuration discovery**

Document Linear-owned fields, import-only mapped projects, attachment refusal,
and that `bb tasks comment` posts user comments to Linear. Document
`linearApiKey` and test-only `LINEAR_SMOKE_API_KEY`. Regenerate templates with
`node packages/templates/scripts/generate-templates.mjs`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts cli/cli.test.ts`

```bash
git add plugins/tasks/cli plugins/tasks/skills docs/configuration.md packages/templates apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md
git commit -m "Expose Linear Tasks sync to agents"
```

### Task 6: Native Tasks UI

**Files:**
- Create: `plugins/tasks/shell/linear-status.tsx`
- Create: `plugins/tasks/shell/linear-status.test.tsx`
- Modify: `plugins/tasks/shell/sidebar.tsx`
- Modify: `plugins/tasks/shell/app-shell.tsx`
- Modify: `plugins/tasks/views/detail/index.tsx`
- Modify: `plugins/tasks/views/board/index.tsx`
- Create: `plugins/tasks/views/board/board.test.tsx`
- Modify: `plugins/tasks/shell/shell.test.tsx`
- Modify: `plugins/tasks/app.css`

**Interfaces:**
- Consumes: `useLinearStatus()` and `linearSyncNow` RPC.
- Displays: connection, viewer, active count, last success, safe error, and icon-only refresh action with tooltip.
- Displays: mapped task identifier and `Open in Linear` action from backend-provided source metadata.

- [ ] **Step 1: Write component tests**

Cover not configured, connected, syncing, rate-limit resume time, failed, disabled duplicate-click, refresh success, mapped task source action, and unmapped task without Linear UI. A board drag rejected by Linear must revert and show the typed error.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks exec vitest run --config vitest.config.ts shell/linear-status.test.tsx shell/shell.test.tsx views/board/board.test.tsx`

Expected: FAIL because the status component is absent.

- [ ] **Step 3: Implement compact sidebar status**

Place an unframed Linear section above Manage. Use existing `Icon`, `Tooltip`, button, and text tokens. Do not add a nested card or expose plugin setup instructions in the task surface; configuration remains in Plugins settings.

- [ ] **Step 4: Implement mapped-task source action**

Render the Linear identifier as a restrained source row and open the canonical HTTPS URL in a new tab with `rel="noreferrer"`. Keep the task description and comments unchanged.

- [ ] **Step 5: Run UI tests, full Tasks tests, and build**

Run: `pnpm exec turbo run test --filter=bb-plugin-tasks > "$BB_THREAD_STORAGE/tasks-test.log" 2>&1`

Run: `tail -200 "$BB_THREAD_STORAGE/tasks-test.log"`

Run: `pnpm exec turbo run typecheck --filter=bb-plugin-tasks`

Run: `pnpm exec turbo run build --filter=bb-plugin-tasks`

Expected: PASS with rebuilt `plugins/tasks/dist` artifacts.

- [ ] **Step 6: Commit**

```bash
git add plugins/tasks
git commit -m "Add native Linear status to Tasks"
```

### Task 7: Distribution, Installation, and Read-Only Smoke Test

**Files:**
- Modify: `plugins/tasks/README.md`
- Create: `plugins/tasks/linear/smoke.test.ts`
- Modify: `docs/superpowers/specs/2026-08-08-linear-tasks-integration-design.md` only if verified installation behavior differs.

**Interfaces:**
- Adds opt-in environment variable `LINEAR_SMOKE_API_KEY` for a read-only developer smoke test only; production still uses the BB secret setting.
- Installs the merged fork checkout's renamed Tasks package as a local `path:` plugin with ID `tasks-linear`.

- [ ] **Step 1: Add the opt-in read-only smoke test**

When `LINEAR_SMOKE_API_KEY` is absent, skip. When present, resolve viewer and fetch at most one page of active assigned issues; do not call any mutation.

- [ ] **Step 2: Run complete verification**

Run: `pnpm exec turbo run test --filter=bb-plugin-tasks > "$BB_THREAD_STORAGE/tasks-test.log" 2>&1`

Run: `tail -200 "$BB_THREAD_STORAGE/tasks-test.log"`

Run: `pnpm exec turbo run typecheck --filter=bb-plugin-tasks`

Run: `pnpm exec turbo run build --filter=bb-plugin-tasks`

Run: `git diff --check`

Expected: all pass. Inspect the bounded test log, and keep ignored source build artifacts out of the feature commit.

- [ ] **Step 3: Document operation and rollback**

Document API-key creation, BB secret setting, healthy-key rotation, manual sync, project linking before delegation, import-only mapped projects, polling/rate-limit behavior, mapped task/comment attachment restriction, flattened sub-issues, and rollback. State that `tasks-linear` owns separate data from disabled builtin `tasks`, and that persisted attachment URLs make this replacement plugin ID permanent.

- [ ] **Step 4: Commit and publish the feature PR to the personal fork**

```bash
git add plugins/tasks docs/superpowers
git commit -m "Document Linear Tasks operation"
git push -u origin feat/linear-tasks-integration
gh pr create --repo theanecdote/bb --base main --head feat/linear-tasks-integration
```

- [ ] **Step 5: Review and merge only the personal-fork PR**

Verify the PR base repository is `theanecdote/bb`, checks pass, and no upstream PR exists. Merge using the user's personal repository workflow.

- [ ] **Step 6: Prepare the renamed local plugin root**

In a dedicated persistent worktree checked out from the merged fork, first
record whether the running BB build resolves
`builtin:tasks` from a packaged `builtin-plugins/tasks` copy or this source
directory. Change `plugins/tasks/package.json` `name` to
`bb-plugin-tasks-linear` and `bb.name` to `Tasks + Linear`; leave `bb.server`,
`bb.app`, skills, and panel path/ID unchanged because they are plugin-scoped.
This deployment worktree remains local and its manifest rename is not pushed.
Run `pnpm install --no-frozen-lockfile`, then build the SDK before the plugin:

```bash
pnpm exec turbo run build --filter=@bb/plugin-sdk
pnpm exec turbo run build --filter=bb-plugin-tasks-linear
test -f packages/plugin-sdk/dist/index.js
```

The explicit SDK build is required because the rename no longer matches the
`bb-plugin-tasks#build` key that supplies that ordering, and BB's path install
also rebuilds the frontend without the SDK's `source` export condition. Do not
create a distribution branch, force-add `dist`, or hand-stamp artifact
metadata: BB derives metadata and CSS scope from the package name. Verify
`git status --porcelain plugins/tasks/package.json pnpm-lock.yaml` shows both
intentional local modifications; neither is pushed, and ignored `dist/`
remaining untracked is expected. Record the rename as the worktree's intentional
deployment state. Before every reinstall or reload after any git operation,
verify this still prints `bb-plugin-tasks-linear`:

```bash
node -p "require('./plugins/tasks/package.json').name"
```

A reverted rename does not fail loudly: the registration can remain
`tasks-linear` while a rebuilt app uses the `tasks` CSS scope and renders
incorrectly.

- [ ] **Step 7: Replace and configure Tasks**

Confirm builtin `tasks` remains disabled, then install
`bb plugin install --yes path:<deployment-worktree>/plugins/tasks`; the CLI
prints its full-trust warning before proceeding. Verify the installed ID is
`tasks-linear` while the registered CLI remains `bb tasks`. Request
`linearApiKey` through BB's plugin secret settings UI; never pass it in CLI argv
or chat. Reload and enable `tasks-linear`.

- [ ] **Step 8: Perform the live read-only sync smoke test**

Run manual sync, confirm the authenticated viewer, confirm assigned incomplete Perihelion issues appear once with exact keys, confirm no Linear mutation occurred, link one imported Tasks project to the correct BB project, and verify delegation becomes available only after linking.

- [ ] **Step 9: Final safety checks**

Confirm no upstream PR, no webhook/public share, no secret in git/logs/RPC, no
duplicate tasks, no CLI collision with disabled builtin Tasks, and no unintended
Linear comments or state changes. Rollback disables/removes `tasks-linear` and
does not migrate replacement data. If the recorded builtin root is a packaged
copy or a different source checkout, re-enable `builtin:tasks`. Only if BB is
running from the deployment worktree itself, first revert
`plugins/tasks/package.json` to `bb-plugin-tasks`, run `pnpm install`, and then
re-enable the builtin plugin.
