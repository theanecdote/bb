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
- Write supported BB user actions back to the same Linear issue.
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
- Synchronizing attachments, projects, cycles, labels, estimates, or relations.
- Changing Linear repository integrations or GitHub automation.

## Architecture

The integration is a module inside `plugins/tasks`, not a separate plugin. This
keeps task mutation, mapping persistence, realtime invalidation, and frontend
state under one transaction boundary and avoids introducing a private
cross-plugin API.

The module has four units:

1. `LinearClient` sends bounded GraphQL requests, validates HTTP and GraphQL
   responses, paginates assigned issues, and performs issue-state and comment
   mutations.
2. `LinearMappingStore` owns the Linear issue to BB task mapping and sync
   metadata in the Tasks plugin database.
3. `LinearSyncService` resolves the viewer, fetches incomplete assigned issues,
   maps their fields, and upserts BB projects and tasks transactionally.
4. Tasks UI additions show connection and sync state and provide `Sync now`.

The existing Tasks store remains the only writer of task domain rows. Linear
integration code calls store methods rather than issuing ad hoc writes to Tasks
tables.

## Configuration and Authentication

Tasks adds one secret setting:

- `linearApiKey`: personal Linear API key, stored by BB as a secret setting.

The key is read only in backend handlers and services. It is sent to
`https://api.linear.app/graphql` in the `Authorization` header, never returned
to the frontend, stored in SQLite, included in query parameters, or logged.

The UI reports `Not configured`, `Connected`, or a typed connection failure. It
never displays a credential fragment. Settings changes require the standard BB
plugin reload behavior.

## Imported Scope

At each full sync, the backend resolves `viewer` and fetches all issues that:

- are assigned to that viewer;
- are not archived; and
- have a workflow-state type other than completed or canceled.

The query uses Relay cursor pagination until `hasNextPage` is false. A hard page
and issue count guard prevents unbounded work if the upstream response is
unexpected.

An imported issue belongs to a BB Tasks project representing its Linear team.
The mapping store identifies these projects by Linear team ID; names alone are
not identities. Project prefixes are derived from the team key and made unique
through the existing Tasks prefix validation rules.

## Field Mapping

Linear-owned fields refresh on every successful sync:

| Linear | BB Tasks |
| --- | --- |
| issue ID | mapping identity |
| identifier | source metadata and task description |
| title | title |
| description | description, followed by canonical Linear URL |
| priority 1/2/3/4/0 | urgent/high/medium/low/none |
| due date | due date |
| workflow type backlog | backlog |
| workflow type unstarted | todo |
| workflow type started | in_progress |
| workflow type completed | done |
| workflow type canceled | canceled |

Linear has no portable `in_review` workflow type. During inbound sync, any
started Linear state maps to `in_progress`. During outbound status mutation,
`in_review` maps to a team state named `In Review` when one exists; otherwise it
falls back to the team's first started state.

Linear descriptions are stored as Markdown. The integration appends a small
source section containing the issue identifier and URL. It does not copy the
Linear comment transcript.

## Durable Mapping

The Tasks database gains append-only migrations for:

- one row per Linear team project mapping;
- one row per Linear issue task mapping;
- the Linear `updatedAt` value last applied;
- the last successful sync time and last typed sync error.

Linear issue ID is unique, as is the mapped BB task ID. Upsert is idempotent.
Deleting a BB task removes its mapping through a foreign-key cascade; a later
sync may import the still-assigned incomplete Linear issue again.

When a previously mapped issue is no longer in the active result set, the sync
performs a targeted lookup before changing local state. Completed and canceled
issues become `done` and `canceled`. Unassigned or archived issues become
`canceled` locally while retaining their mapping. Transient pagination or API
failure never causes mass cancellation.

## Outbound Mutations

Only explicit user actions write to Linear:

- A user changing the status of a mapped BB task updates the Linear issue's
  workflow state.
- A BB comment with kind `user` on a mapped task creates a Linear comment.

Agent and system comments remain BB-local. Title, description, priority, and
due-date edits are read-only projections in the initial release; a subsequent
sync restores Linear values. The UI identifies mapped tasks as Linear-owned so
this behavior is not surprising.

Outbound operations call Linear first. BB applies the requested local mutation
only after Linear confirms success. This avoids displaying a local state that
was rejected upstream. A manual or periodic sync reconciles accepted upstream
changes.

## Synchronization

Synchronization runs:

- once after plugin startup when a key is configured;
- every five minutes while the plugin is running; and
- on explicit `Sync now` from the Tasks UI.

Only one sync may run at a time. Concurrent requests join or receive the same
result rather than starting duplicate fetches. The service uses request
timeouts, bounded pagination, and no autonomous retry loop. The next scheduled
or manual sync is the retry mechanism.

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

## Error Handling

Backend errors use a small stable set:

- `LINEAR_NOT_CONFIGURED`
- `LINEAR_UNAUTHORIZED`
- `LINEAR_RATE_LIMITED`
- `LINEAR_API_ERROR`
- `LINEAR_INVALID_RESPONSE`
- `LINEAR_TIMEOUT`
- `LINEAR_MAPPING_ERROR`

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
- prevention of mass cancellation after partial or failed fetches;
- outbound status and user-comment mutations;
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

After merge, a distribution branch containing the built Tasks plugin artifacts
is created in the same personal fork. The currently disabled builtin Tasks
plugin is replaced with that managed git plugin, configured through BB's secret
setting, enabled, reloaded, and smoke-tested. Rollback removes the managed
plugin and reinstalls `builtin:tasks`; Linear data remains isolated to the
managed plugin's own database and secret storage.

