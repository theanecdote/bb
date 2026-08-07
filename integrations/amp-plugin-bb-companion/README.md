# amp-plugin-bb-companion

Amp-side companion plugin for BB. It exposes a narrow authenticated local API
on a loopback-only port and uses the stable Amp Plugin API to create and
continue threads on an existing live Runner.

It does not manage BB state, run shell commands for BB, expose filesystem
access, mirror transcripts, provision runners, restart Amp, or patch Amp core.

## Verified API Basis

Checked on 2026-08-07:

- Amp CLI: `0.0.1785328548-gc93a97`
- `@ampcode/plugin`: `0.0.0-20260807011345-gf2437d1`
- `@ampcode/sdk`: `0.1.0-20260729105907-g72d5ca3`

Stable Plugin API used:

- `amp.getBuiltinAgent(mode)`
- `agent.createThread({ executor: { type: "runner", id } })`
- `thread.appendUserMessage(...)`
- `amp.threads.get(threadId)`
- `thread.state.get()`
- `thread.waitForResponse(...)`
- `thread.cancel()`
- `thread.id`

The current TypeScript SDK type exposes only:

```ts
executor?: "local" | "orb"
```

so this companion remains necessary for named live Runner targeting.

## Lifecycle

Amp plugin docs say plugins are Bun-executed long-lived processes that may run
for multiple threads concurrently. The default export runs when the plugin
loads, and `amp.onDispose(...)` is called on unload/reload/graceful shutdown.

Because multiple `amp --no-tui` runner processes can load system plugins, this
plugin has a `control` flag. Only the designated control instance binds the
loopback port. Non-control instances load inertly and avoid port conflicts.

## Configuration

Generate a secret outside the repository:

```sh
openssl rand -base64 32
```

Write owner-only plugin-local configuration to
`~/.config/amp/bb-companion.json`, for example:

```json
{
  "enabled": true,
  "control": true,
  "port": 43931,
  "secret": "GENERATED_SECRET",
  "allowedRunners": ["ice-by-snowboard"],
  "maxMessageBytes": 65536
}
```

Then restrict it:

```sh
chmod 600 ~/.config/amp/bb-companion.json
```

The companion reads only this fixed plugin-local configuration file (or the
path in `BB_COMPANION_CONFIG`) and refuses group/world-accessible permissions.
After installing or editing config, reload plugins from an Amp client with
`plugins: reload`. Do not create or restart a Runner for this plugin.

## Installation

System plugin location:

```text
~/.config/amp/plugins/bb-companion.ts
```

Install this local file:

```sh
mkdir -p ~/.config/amp/plugins
cp /home/exedev/amp-plugin-bb-companion/bb-companion.ts ~/.config/amp/plugins/bb-companion.ts
cp /home/exedev/amp-plugin-bb-companion/bb-companion-client.mjs ~/.config/amp/plugins/bb-companion-client.mjs
```

The companion binds only `127.0.0.1` on the configured port. It never binds
`0.0.0.0` and does not use an exe.dev public share. A remote BB server uses its
stable enrolled-host terminal API to invoke `bb-companion-client.mjs`, which
accepts one stdin request and can forward only the narrow companion routes.
Bearer authentication remains mandatory at the companion.

## API

Allowed endpoints only:

```text
POST /v1/threads
POST /v1/threads/:id/messages
GET  /v1/threads/:id
POST /v1/threads/:id/cancel
```

Every request requires:

- `Authorization: Bearer <secret>`
- `Content-Type: application/json` for POST
- schema validation
- body size limits
- method and route allow-list

Runner IDs are validated against `allowedRunners`. A BB-supplied runner ID is
never trusted by itself.

## Verification

```sh
npm run typecheck
npm test
```

Opt-in real smoke test:

1. Ensure the existing `amp --no-tui --runner-id ice-by-snowboard` process is
   still running.
2. Install and configure the companion with the same secret as `bb-plugin-amp`.
3. Reload Amp plugins without changing the runner ID.
4. Configure the BB plugin target mapping to the same host and repo path.
5. Open a BB planning thread and click `Send to Amp`.
6. Confirm exactly one Amp thread is created, the thread URL opens on
   ampcode.com, and follow-up goes to the same thread.

Do not ask the first smoke test to modify repository files.
