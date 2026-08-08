# Linear Integration for BB Tasks

## Summary

Add a native Linear integration to the existing BB Tasks plugin. Linear remains
the authoritative issue tracker. BB Tasks stores a bounded projection of the
current Linear user's incomplete assigned issues so those issues can participate
in BB's existing task UI, mentions, delegation, and agent-thread workflows.

The integration uses Linear's public GraphQL API directly. It does not reuse an
agent provider's Linear connector credentials, scrape the Linear UI, or add a
second task-management surface.

## Goals

- Import every incomplete issue assigned to the authenticated Linear user.
- Keep one durable Linear issue to BB task mapping and prevent duplicates.
- Refresh Linear-owned fields through manual and periodic synchronization.
- Write every supported BB task edit back to the same Linear issue.
- Preserve the existing Tasks UI and delegation behavior.
- Keep the Linear credential in BB plugin secret storage.
- Install the modified Tasks plugin from the user's personal BB fork only.

## Non-Goals

- General Linear workspace mirroring.
- Importing completed, canceled, archived, or unassigned issues as new tasks.
- Mirroring all Linear comments into BB.
- Sending agent or system execution comments to Linear.
- Linear OAuth application registration.
- Real-time webhooks in the initial release.
- Synchronizing attachments, cycles, labels, estimates, relations, or sub-tasks.
- Changing Linear repository integrations or GitHub automation.

## Architecture

The integration is a module inside `plugins/tasks`, not a separate plugin. This
keeps task mutation, mapping persistence, realtime invalidation, and frontend
state under one transaction boundary and avoids introducing a private
cross-plugin API.

The module has three units:

1. `LinearClient` sends bounded GraphQL requests, validates HTTP and GraphQL
   responses, paginates assigned issues, and performs issue-state and comment
   mutations.
2. `LinearSyncService` owns the prepared mapping statements, resolves the
   viewer, fetches incomplete assigned issues, and upserts BB projects and
   tasks transactionally.
3. Tasks UI additions show connection and sync state and provide `Sync now`.

The existing Tasks store remains the only writer of task domain rows. Every
task status and editable-field mutation, including board moves, CLI updates,
delegation transitions, and attachment-related description behavior, must pass
through a shared domain mutation boundary. Network preparation is awaited
outside better-sqlite3 transactions; it returns a synchronous commit closure
that is applied with local task and mapping writes in one transaction. Linear
integration code never returns a promise from a database transaction. Tests
enumerate `updateTask`, `updatePosition`, and `createTask` write paths in
`api`, `delegate`, and `attachments`.

## Configuration and Authentication

Tasks adds one secret setting:

- `linearApiKey`: personal Linear API key, stored by BB as a secret setting.

The key is read only in backend handlers and services. It is sent to
`https://api.linear.app/graphql` in the `Authorization` header, never returned
to the frontend, stored in SQLite, included in query parameters, or logged.

The UI reports `Not configured`, `Connected`, or a typed connection failure. It
never displays a credential fragment. A settings save reloads the plugin when
it is already in `needs-configuration`; otherwise `settings.onChange` discards
the cached Linear client so the next operation uses the new key.

## Imported Scope

At each full sync, the backend resolves `viewer` and fetches all issues that:

- are assigned to that viewer;
- are not archived; and
- have a workflow-state type in `triage`, `backlog`, `unstarted`, or `started`.

The query uses Relay cursor pagination until `hasNextPage` is false. A hard page
and issue count guard prevents unbounded work if the upstream response is
unexpected.

An imported issue belongs to a BB Tasks project representing its Linear team.
The mapping store identifies these projects by Linear team ID; names alone are
not identities. The Tasks project uses the Linear team key as its prefix and
the Linear identifier number as the task number, so `PER-2165` remains
`PER-2165` in BB. Task numbers in a mapped project are owned by Linear. Local
task creation in that project is refused, so BB never consumes a number Linear
can later assign.

If the Linear team key is already owned by an unmapped Tasks project, sync
stops for that team with `LINEAR_MAPPING_ERROR`; it never silently adopts or
renames the project. The user must rename the conflicting project before
retrying. An imported project starts with `linkedBbProjectId = null`. The
existing Manage surface is used to link it to a BB repository project;
delegation remains explicitly unavailable until that link is configured.

Linear team keys are validated against BB's uppercase alphanumeric prefix rule
before any write. A non-conforming key produces `LINEAR_MAPPING_ERROR` rather
than a raw validation or SQLite error. Linear parent/child relations are not
imported; sub-issues appear as independent BB tasks even when their parent is
also imported. Labels, `parentTaskId`, and project colors remain BB-owned.

## Field Mapping

Linear-owned fields refresh on every successful sync:

| Linear | BB Tasks |
| --- | --- |
| issue ID | mapping identity |
| identifier | BB task key |
| title | title |
| description | description |
| priority 1/2/3/4/0 | urgent/high/medium/low/none |
| due date | due date |
| workflow type triage | todo |
| workflow type backlog | backlog |
| workflow type unstarted | todo |
| workflow type started | in_progress |
| workflow type completed | done |
| workflow type canceled | canceled |
| workflow type duplicate | canceled |

An unknown workflow-state type maps to `backlog` and is logged once per state
ID; it is never silently dropped.

Linear has no portable `in_review` workflow type. Each mapping stores the exact
`linear_state_id` last observed. Inbound sync only overwrites the BB status when
that state ID changed. Therefore a local `in_review` remains intact while the
corresponding Linear started state is unchanged. During outbound status
mutation, `in_review` maps to a case-insensitive team state named `In Review`
when one exists; otherwise it uses the started state with the lowest `position`
and then lowest ID, and stores that selected state ID.

Linear descriptions are stored as Markdown. Source identity and URL live in
the mapping/API projection rather than being appended to the description. The
integration does not copy the Linear comment transcript.

## Durable Mapping

The Tasks database gains one append-only entry in the existing
`plugins/tasks/db/schema.ts` `MIGRATIONS` array. Its array index plus one is the
schema version; the integration does not introduce a second migration system.
The migration adds:

- one row per Linear team project mapping;
- one row per Linear issue task mapping;
- the Linear state ID and `updatedAt` value last applied;
- an active/inactive mapping marker;
- the last successful sync time and last typed sync error.

Linear issue ID is unique, as is the mapped BB task ID. Upsert is idempotent.
Deleting a BB task removes its mapping through a foreign-key cascade; a later
sync may import the still-assigned incomplete Linear issue again.

When a previously mapped issue is no longer in the active result set, the sync
re-queries all missing mapped IDs in bounded batches with archived resources
included. Reconciliation precedence is completed to `done`, canceled or
duplicate to `canceled`, then archived or unassigned to inactive with local
status preserved. Transient pagination, partial GraphQL data, or API failure
never causes mass inactivation or status changes. A completed and archived
issue therefore becomes `done`, not merely inactive.

If an issue moves to a different Linear team, the old mapping becomes inactive
with a mapping diagnostic and the issue is imported as a new task under the new
team. The old BB task retains comments and threads.

Sync compares all projected values before calling `updateTask`. Rows with no
actual field change are not updated. This preserves the Tasks list revision and
keeps existing pagination cursors valid across no-op five-minute syncs.
When Linear `updatedAt` equals the stored value, projection is skipped while
mapping liveness is still refreshed.

## Outbound Mutations

Every supported mutation of a mapped task writes to Linear first:

- Status changes from the UI, board move, CLI, delegation, or agent completion
  update the Linear issue's workflow state.
- Title, description, priority, and due-date changes update the Linear issue.
- A BB comment with kind `user` on a mapped task creates a Linear comment.

Agent and system comments remain BB-local. CLI comments use the existing
`kind = user` behavior and therefore write to Linear. Labels and sub-tasks stay
BB-local. Task and comment attachments on mapped tasks are rejected because
current attachment paths embed BB-local references. User comment bodies
containing a BB attachment URL are rejected before reaching Linear.

Mapped-task description autosave uses a ten-second debounce instead of the
ordinary 800 ms delay, with an immediate flush on blur or task-detail unmount.
Title edits are already discrete save actions. Status, priority, and due-date
changes are not coalesced. A failed description write is not retried faster
than the same ten-second window.

Outbound operations call Linear first. BB applies the requested local mutation
only after Linear confirms success. This avoids displaying a local state that
was rejected upstream. A manual or periodic sync reconciles accepted upstream
changes.

Delegation is the one irreversible path: the agent thread is spawned before
the automatic status transition. If Linear rejects that transition, the thread
remains attached, the local status transition is not applied, and a safe
mapping error is recorded for later reconciliation.

BB keeps its own system-comment audit trail while Linear keeps its issue
history. These audit streams are not mirrored or reconciled.

## Synchronization

Synchronization runs:

- once after plugin startup when a key is configured;
- every five minutes while the plugin is running; and
- on explicit `Sync now` from the Tasks UI.

Only one sync may run at a time. The background service follows the existing
GitHub plugin pattern: initial sync followed by abort-aware five-minute sleeps.
Concurrent manual/background requests share the same in-flight promise. The
service uses request timeouts, bounded pagination, and no autonomous retry
loop. The next scheduled or manual sync is the retry mechanism.

The service catches ordinary sync failures inside its loop, records a safe
error, waits five minutes, and continues; they never escape and trigger the
host's crash restart. Missing or rejected credentials use
`NeedsConfigurationError`. Rate-limit errors retain `Retry-After` or Linear
reset metadata, suppress scheduled sync until that instant, and report the
resume time. Full-list frontend traversal restarts from a cursor-less request
on `stale_cursor`, bounded to three attempts.

The initial release uses polling because Linear webhooks require a public HTTPS
receiver and workspace-admin or OAuth application setup. No exe.dev public
share is created for this integration.

## UI

The existing Tasks navigation receives a compact Linear integration section:

- connection state;
- authenticated viewer name when connected;
- last successful sync time;
- number of active mapped issues;
- last safe error message; and
- `Sync now` action.

Mapped tasks display a Linear source indicator and an `Open in Linear` action.
The plugin does not add a second issue list or duplicate the Linear transcript.
The same status and manual-sync functions are exposed as
`bb tasks linear status` and `bb tasks linear sync`; neither accepts a key.

## Error Handling

Backend errors use a small stable set:

- `LINEAR_RATE_LIMITED`
- `LINEAR_API_ERROR`
- `LINEAR_MAPPING_ERROR`

Task-domain mutations additionally return `linear_write_failed`,
`linear_rate_limited`, `linear_mapping_error`, or `linear_project_readonly`
inside the existing typed mutation result. Board and list optimistic updates
roll back and show the safe message instead of throwing or silently snapping
back.

Missing or rejected credentials use `bb.status.needsConfiguration` and a safe
status message rather than adding frontend-only error variants. Invalid
responses and timeouts are reported as `LINEAR_API_ERROR` with safe messages.

GraphQL responses containing an `errors` array are failures even when HTTP
status is 200. Internal logs include operation names, status codes, and issue
identifiers where useful, but never request headers, credentials, full issue
descriptions, GraphQL variable payloads, or stack traces in frontend responses.

A failed full sync leaves existing tasks and mappings unchanged. A failed
outbound mutation leaves the corresponding local user mutation unapplied and
returns an actionable error.

## Testing

Unit and plugin-host tests cover:

- secret configuration without frontend exposure;
- viewer and paginated issue fetching;
- incomplete-assignee filtering;
- team project creation and reuse by team ID;
- field and workflow-state mapping;
- idempotent imports and refreshes;
- completed, canceled, unassigned, and archived reconciliation;
- prevention of mass inactivation after partial or failed fetches;
- outbound status and editable-field mutations from UI, board, CLI,
  delegation, and agent completion paths;
- exact Linear key preservation and prefix-conflict refusal;
- `linear_state_id` merge behavior preserving local `in_review`;
- no-op sync preserving the task-list revision;
- inactive mappings preserving local task state;
- delegation refusal until the imported project is linked to a BB project;
- mapped-task attachment refusal;
- mapped-project local-task creation refusal;
- two-phase async preparation outside synchronous transactions;
- mapped-description write coalescing and bounded failure retry;
- duplicate, triage, unknown, completed+archived, and cross-team states;
- cursor restart across concurrent background writes;
- API-key rotation and background-loop error containment;
- typed board/list mutation errors;
- outbound user-comment mutations, including CLI comments;
- suppression of agent and system comment write-back;
- unauthorized, rate-limited, malformed, partial GraphQL, and timeout errors;
- single-flight manual and scheduled synchronization;
- Linear source indicator and sync-state UI.

An opt-in smoke test uses a real Linear API key to fetch the viewer's active
assigned issues without mutating Linear. Write mutations are verified against a
fake GraphQL server by default.

## Distribution and Installation

Changes are committed on a feature branch in
`https://github.com/theanecdote/bb`, reviewed through a PR against that fork's
`main`, and merged there only. No PR is opened against `get-bb/bb`.

After merge, the fork checkout's Tasks package is renamed to
`bb-plugin-tasks-linear`, whose installable plugin ID is `tasks-linear`; BB
therefore does not violate the reserved bundled `tasks` ID. It is installed as
a `path:` plugin from that checkout. A `git:` install is not viable: BB installs
git plugins' runtime dependencies with npm and rebuilds both bundles from
source, while Tasks depends on the private, unpublished workspace package
`@bb/shared-ui`. Path installs skip dependency installation and resolve that
package through the checkout's existing workspace links. The builtin Tasks
plugin remains disabled. The replacement still registers the native `bb tasks`
CLI command, Tasks navigation, RPC, and Tasks skill.

The deployment worktree has `@bb/plugin-sdk` built before installation. BB's
path install rebuilds the frontend bundle from source and resolves the SDK root
through its published `dist` entry, while the package rename removes the
Tasks-specific Turbo task that would otherwise order that build.

Before installation, Tasks is made plugin-ID agnostic: backend paths use
`bb.pluginId`, frontend attachment transport paths come from a backend RPC
value built from that ID, and spawned-thread attribution remains host-derived
from the runtime plugin ID. The frontend RPC is necessary because the public
app SDK context exposes project and thread IDs, but not the owning plugin ID.
Persisted attachment references contain plugin-scoped URLs, so `tasks-linear`
becomes a permanent identity once replacement content exists.

The replacement owns a separate `tasks-linear` database, KV namespace,
settings, and secrets. Existing builtin Tasks data is not migrated. Rollback
disables or removes `tasks-linear`; projected tasks remain in the replacement
namespace and do not appear in builtin Tasks. In a packaged BB build,
`builtin:tasks` is a separate copy and can then be re-enabled. In a source
build, the builtin registry resolves `builtin:tasks` relative to the running
server's own module directory. If that is a checkout other than the deployment
worktree, the builtin is untouched and can be re-enabled directly. It only
collides when BB itself runs from the deployment worktree, in which case
rollback also requires reverting that package name to `bb-plugin-tasks` and
running `pnpm install`. Installation records which builtin root the running BB
build uses before replacing the plugin.
