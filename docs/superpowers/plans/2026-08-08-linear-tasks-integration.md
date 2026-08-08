# Linear Integration for BB Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project every incomplete Linear issue assigned to the authenticated user into native BB Tasks and write supported BB task edits back to Linear.

**Architecture:** Extend the existing `tasks` plugin in place. A small raw-GraphQL client owns Linear transport, a sync service owns mappings and projection, and a shared task mutation hook sends mapped task changes upstream before local commit. The current Tasks RPC, CLI, delegation, realtime, and UI surfaces remain authoritative for BB behavior.

**Tech Stack:** TypeScript, BB Plugin SDK 0.4.1, `fetch`, Linear GraphQL API, better-sqlite3, Zod 4, React 19, Vitest 4, Testing Library.

## Global Constraints

- Linear is authoritative for mapped issue fields.
- Import all non-archived, incomplete issues assigned to Linear `viewer`.
- Preserve Linear keys exactly (`PER-2165` remains `PER-2165`).
- Store `linearApiKey` only as a BB secret setting; never log or return it.
- Use the existing Tasks `MIGRATIONS` array; do not add another migration mechanism.
- Update task rows only when projected values changed.
- Write status, title, description, priority, and due-date changes to Linear before local commit.
- Write only `kind = user` comments to Linear; agent and system comments remain local.
- Keep labels and sub-tasks local; reject attachments on mapped tasks.
- Use initial plus five-minute polling; do not expose a webhook endpoint.
- Publish and install only from `https://github.com/theanecdote/bb`; never open an upstream PR.

---

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

Cover personal-key `Authorization`, JSON content type, a 10-second abort timeout, HTTP 401, HTTP 429, HTTP 5xx, malformed JSON, GraphQL `errors` on HTTP 200, and responses containing both `data` and `errors`. Assert no thrown error contains the API key or GraphQL variables.

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

Use operation names and variables, never string interpolation. Parse every response with Zod. Treat any non-empty GraphQL `errors` array as a complete failure. Map `429` to `LINEAR_RATE_LIMITED`; map authentication, timeout, protocol, and GraphQL failures to `LINEAR_API_ERROR` with safe messages.

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

Run: `pnpm --filter bb-plugin-tasks test -- linear/client.test.ts`

Run: `pnpm --filter bb-plugin-tasks typecheck`

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

- [ ] **Step 1: Write migration and identity tests**

Append one migration that creates `linear_team_projects`, `linear_issue_tasks`, and singleton `linear_sync_state`. Add uniqueness and cascading foreign keys for Linear team ID, issue ID, task ID, and Tasks project ID.

Assert an explicit imported task number creates `PER-2165`, advances `next_task_number` to at least 2166, and a second import of the same issue returns its existing mapping.

- [ ] **Step 2: Run DB tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks test -- db.test.ts linear/store.test.ts`

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

Run: `pnpm --filter bb-plugin-tasks test -- db.test.ts linear/store.test.ts`

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

Cover priority, due date, workflow type, team project creation, exact identifier number, duplicate sync, changed-field refresh, and no-op revision preservation. Verify a pre-existing unmapped project with the same team prefix yields `LINEAR_MAPPING_ERROR` without importing partial team data.

- [ ] **Step 2: Run sync tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks test -- linear/sync.test.ts`

Expected: FAIL because `createLinearSyncService` is absent.

- [ ] **Step 3: Implement active projection transaction**

For each complete assigned snapshot, group by Linear team, validate every prefix before mutations, create/reuse mapped projects, create/reuse tasks, update only changed fields, and update mapping state in the same transaction. Publish `projects:changed` and `tasks:changed` only for actual changes.

- [ ] **Step 4: Write reconciliation tests**

Cover missing mapped IDs fetched in batches: completed becomes `done`, canceled becomes `canceled`, unassigned/archived becomes inactive without local status mutation, and later reassignment reactivates the same task. Assert failed or partial active fetch performs no reconciliation.

- [ ] **Step 5: Implement state-ID merge semantics**

If remote `state.id` equals stored `linearStateId`, preserve local `in_review`. If it differs, map the new remote workflow type and update both local status and stored state ID.

- [ ] **Step 6: Add single-flight and failure-state tests**

Two concurrent `sync()` calls must return the same promise and execute one active query. Failed sync stores a safe error and leaves `lastSuccessfulSyncAt` and task rows untouched.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm --filter bb-plugin-tasks test -- linear/sync.test.ts`

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
- Modify: `plugins/tasks/cli/cli.test.ts`
- Modify: `plugins/tasks/delegate/delegate.test.ts`
- Modify: `plugins/tasks/attachments/attachments.test.ts`

**Interfaces:**
- Produces: `LinearMutationBridge.beforeTaskMutation(current, patch)`.
- Produces: `LinearMutationBridge.beforeUserComment(taskId, body)`.
- Produces: `LinearMutationBridge.assertAttachmentAllowed(taskId)`.
- Produces: `TaskMutationOrigin = "user" | "cli" | "delegation" | "agent" | "linear-sync"`; only `linear-sync` bypasses outbound Linear mutation.
- Changes: API `updateTask` and `boardMove` handlers become async and invoke the bridge before local mutation.

- [ ] **Step 1: Write status and editable-field mutation tests**

Cover RPC update, board move, CLI update, delegation `todo -> in_progress`, and agent CLI `in_review`. Assert `issueUpdate` succeeds before the local transaction and a rejected Linear mutation leaves BB unchanged.

- [ ] **Step 2: Run mutation tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks test -- linear/mutations.test.ts cli/cli.test.ts delegate/delegate.test.ts`

Expected: FAIL because direct write paths bypass the bridge.

- [ ] **Step 3: Implement workflow-state resolution and issue updates**

Cache each team's workflow states for one sync interval. Map BB statuses by Linear workflow type; resolve `in_review` by case-insensitive exact name first, then the first stable started state. On success, save the returned state ID/remote timestamp in the mapping.

- [ ] **Step 4: Route direct status paths through the bridge**

Update `api` board/update handlers and delegation's automatic status transition. Preserve system comments and realtime notifications after successful local commit. Add a regression search/test that the known mapped-task status paths no longer call `store.tasks.updateTask` directly.

Inbound projection calls the same domain mutation boundary with origin
`linear-sync`; that origin applies the change-aware local update without
echoing an `issueUpdate` mutation back to Linear.

- [ ] **Step 5: Implement user-comment and attachment policy**

Call `commentCreate` before storing mapped `kind = user` comments. Do not call it for `agent` or `system`. Reject mapped-task attachment creation before writing a blob or modifying description; leave unmapped attachment behavior unchanged.

- [ ] **Step 6: Run mutation, CLI, delegation, and attachment tests**

Run: `pnpm --filter bb-plugin-tasks test -- linear/mutations.test.ts cli/cli.test.ts delegate/delegate.test.ts attachments/attachments.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/tasks/api plugins/tasks/linear/mutations.ts plugins/tasks/linear/mutations.test.ts plugins/tasks/delegate plugins/tasks/attachments plugins/tasks/cli/cli.test.ts
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

**Interfaces:**
- Adds secret setting `linearApiKey`.
- Adds RPC `linearStatus: null -> LinearSyncStatus`.
- Adds RPC `linearSyncNow: null -> LinearSyncResult`.
- Publishes realtime channel `linear:changed`.
- Registers background service `linear-sync`.

- [ ] **Step 1: Write plugin-host registration tests**

Assert the secret descriptor is registered with `secret: true`, RPC output never contains the key, missing/unauthorized credentials call `bb.status.needsConfiguration`, and configured startup registers one abortable background service.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks test -- server.test.ts linear/index.test.ts`

Expected: FAIL because Linear settings and RPC methods are absent.

- [ ] **Step 3: Implement lifecycle registration**

Create the client/service lazily from `settings.get()` inside handlers/service start. The service runs one sync, then waits five minutes with an abort-aware timer. Manual and background calls use the sync service's shared in-flight promise.

- [ ] **Step 4: Extend the strict RPC contract and frontend hooks**

Add Zod schemas for configured state, viewer name, active issue count, last success, safe error, sync counts, and mapping source metadata. Add `linear:changed` to invalidation channels and `useLinearStatus()` to `shell/data.ts`.

- [ ] **Step 5: Run server tests and typecheck**

Run: `pnpm --filter bb-plugin-tasks test -- server.test.ts linear/index.test.ts`

Run: `pnpm --filter bb-plugin-tasks typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/tasks/server.ts plugins/tasks/server.test.ts plugins/tasks/shared/contract.ts plugins/tasks/shell/data.ts plugins/tasks/linear/index.ts plugins/tasks/linear/index.test.ts
git commit -m "Register Linear sync lifecycle"
```

### Task 6: Native Tasks UI

**Files:**
- Create: `plugins/tasks/shell/linear-status.tsx`
- Create: `plugins/tasks/shell/linear-status.test.tsx`
- Modify: `plugins/tasks/shell/sidebar.tsx`
- Modify: `plugins/tasks/shell/app-shell.tsx`
- Modify: `plugins/tasks/views/detail/index.tsx`
- Modify: `plugins/tasks/shell/shell.test.tsx`
- Modify: `plugins/tasks/app.css`

**Interfaces:**
- Consumes: `useLinearStatus()` and `linearSyncNow` RPC.
- Displays: connection, viewer, active count, last success, safe error, and icon-only refresh action with tooltip.
- Displays: mapped task identifier and `Open in Linear` action from backend-provided source metadata.

- [ ] **Step 1: Write component tests**

Cover not configured, connected, syncing, failed, disabled duplicate-click, refresh success, mapped task source action, and unmapped task without Linear UI.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `pnpm --filter bb-plugin-tasks test -- shell/linear-status.test.tsx shell/shell.test.tsx`

Expected: FAIL because the status component is absent.

- [ ] **Step 3: Implement compact sidebar status**

Place an unframed Linear section above Manage. Use existing `Icon`, `Tooltip`, button, and text tokens. Do not add a nested card or expose plugin setup instructions in the task surface; configuration remains in Plugins settings.

- [ ] **Step 4: Implement mapped-task source action**

Render the Linear identifier as a restrained source row and open the canonical HTTPS URL in a new tab with `rel="noreferrer"`. Keep the task description and comments unchanged.

- [ ] **Step 5: Run UI tests, full Tasks tests, and build**

Run: `pnpm --filter bb-plugin-tasks test`

Run: `pnpm --filter bb-plugin-tasks typecheck`

Run: `pnpm --filter bb-plugin-tasks build`

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
- Produces a self-contained `distribution/tasks-linear` branch rooted at the Tasks plugin package.

- [ ] **Step 1: Add the opt-in read-only smoke test**

When `LINEAR_SMOKE_API_KEY` is absent, skip. When present, resolve viewer and fetch at most one page of active assigned issues; do not call any mutation.

- [ ] **Step 2: Run complete verification**

Run: `pnpm --filter bb-plugin-tasks test`

Run: `pnpm --filter bb-plugin-tasks typecheck`

Run: `pnpm --filter bb-plugin-tasks build`

Run: `git diff --check`

Expected: all pass and the worktree is clean after committing generated artifacts.

- [ ] **Step 3: Document operation and rollback**

Document API-key creation, BB secret setting, reload requirement, manual sync, project linking before delegation, polling behavior, mapped-task attachment restriction, and rollback. State that uninstall preserves same-id KV/data DB but removes settings and secrets.

- [ ] **Step 4: Commit and publish the feature PR to the personal fork**

```bash
git add plugins/tasks docs/superpowers
git commit -m "Document Linear Tasks operation"
git push -u origin feat/linear-tasks-integration
gh pr create --repo theanecdote/bb --base main --head feat/linear-tasks-integration
```

- [ ] **Step 5: Review and merge only the personal-fork PR**

Verify the PR base repository is `theanecdote/bb`, checks pass, and no upstream PR exists. Merge using the user's personal repository workflow.

- [ ] **Step 6: Build and push the distribution branch**

Create an isolated export containing `plugins/tasks` package contents at repository root, including metadata-validated `dist/server.js`, `dist/app.js`, CSS, source maps, logos, skills, README, and package manifest. Push it as `distribution/tasks-linear` to `theanecdote/bb`.

- [ ] **Step 7: Replace and configure Tasks**

Record current plugin status, remove the disabled builtin `tasks`, install `git:https://github.com/theanecdote/bb.git@distribution/tasks-linear`, and request `linearApiKey` through BB's plugin secret settings UI. Never pass the key in CLI argv or chat. Reload and enable `tasks`.

- [ ] **Step 8: Perform the live read-only sync smoke test**

Run manual sync, confirm the authenticated viewer, confirm assigned incomplete Perihelion issues appear once with exact keys, confirm no Linear mutation occurred, link one imported Tasks project to the correct BB project, and verify delegation becomes available only after linking.

- [ ] **Step 9: Final safety checks**

Confirm no upstream PR, no webhook/public share, no secret in git/logs/RPC, no duplicate tasks, and no unintended Linear comments or state changes.
