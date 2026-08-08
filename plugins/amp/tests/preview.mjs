/**
 * Render the built Amp panel in a browser for visual review.
 *
 * BB's plugin bundle expects the host to supply React and the app SDK on
 * `globalThis.__bbPluginRuntime`, so this harness supplies a stub runtime with
 * canned RPC responses and mounts the real `dist/app.js` panel registration.
 * It renders the shipped component and stylesheet, not a replica.
 *
 *   npm run build && npm run preview            # writes an HTML page
 *   npm run preview -- --screenshot out.png     # needs a local Chrome
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const screenshotIndex = process.argv.indexOf("--screenshot");
const screenshotPath =
  screenshotIndex < 0 ? null : process.argv[screenshotIndex + 1];
const widthIndex = process.argv.indexOf("--width");
const panelWidth = widthIndex < 0 ? 380 : Number(process.argv[widthIndex + 1]);

const HARNESS = `
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

const PANEL_STATE = ${JSON.stringify(
  {
    configured: true,
    selectedTarget: { name: "Roster Amp", runnerId: "ice-by-snowboard" },
    link: {
      bbThreadId: "thr_1",
      ampThreadId: "T-9f3c21a8",
      runnerId: "ice-by-snowboard",
      targetName: "Roster Amp",
      createdAt: "2026-08-08T11:58:00.000Z",
      lastKnownState: "running",
      threadUrl: "https://ampcode.com/threads/T-9f3c21a8",
    },
    links: [
      {
        bbThreadId: "thr_1",
        ampThreadId: "T-9f3c21a8",
        runnerId: "ice-by-snowboard",
        targetName: "Roster Amp",
        createdAt: "2026-08-08T11:58:00.000Z",
        lastKnownState: "running",
        threadUrl: "https://ampcode.com/threads/T-9f3c21a8",
      },
      {
        bbThreadId: "thr_1",
        ampThreadId: "T-41b7ce02",
        runnerId: "ice-by-snowboard",
        targetName: "Roster Amp",
        createdAt: "2026-08-08T10:30:00.000Z",
        lastKnownState: "idle",
        threadUrl: "https://ampcode.com/threads/T-41b7ce02",
      },
      {
        bbThreadId: "thr_1",
        ampThreadId: "T-0c55da91",
        runnerId: "ice-by-snowboard",
        targetName: "Roster Amp",
        createdAt: "2026-08-08T09:05:00.000Z",
        lastKnownState: "failed",
      },
    ],
    acpChildren: [
      {
        bbThreadId: "thr_child_1",
        title: "Port the transcript reader to the new companion API",
        status: "active",
        createdAt: Date.UTC(2026, 7, 8, 11, 40),
      },
      {
        bbThreadId: "thr_child_2",
        title: "Investigate flaky link migration test",
        status: "idle",
        createdAt: Date.UTC(2026, 7, 8, 8, 12),
      },
    ],
    canSend: true,
    reason: null,
    managedWorktree: false,
    dirty: false,
    repo: {
      path: "/home/exedev/repos/roster",
      branch: "distribution/amp-plugin",
      head: "b12c319",
      remoteHash: null,
    },
  },
  null,
  2,
)};

const MESSAGES = {
  messages: [
    {
      id: "m1",
      role: "user",
      text: "Source: BB\\n\\nMigrate the companion link store to a bounded list.",
    },
    {
      id: "m2",
      role: "assistant",
      text: "Read \`links.ts\` and \`contract.ts\` first. The legacy \`link:<id>\` row stays readable, so existing threads keep their run.",
    },
  ],
  nextOffset: 40,
};

const rpc = {
  call: async (method) => {
    if (method === "getPanelState") return PANEL_STATE;
    if (method === "getMessages") return MESSAGES;
    if (method === "getRunSnapshot") {
      return {
        link: PANEL_STATE.link,
        status: { state: PANEL_STATE.link.lastKnownState },
        page: MESSAGES,
      };
    }
    return {};
  },
};

const registrations = { panel: null, header: null };

globalThis.__bbPluginRuntime = {
  react: React,
  jsxRuntime: JsxRuntime,
  pluginSdkApp: {
    Markdown: ({ content, className }) =>
      React.createElement("div", { className }, content),
    definePluginApp: (setup) => {
      setup({
        slots: {
          threadPanelAction: (registration) => {
            registrations.panel = registration.component;
          },
          experimental_threadHeaderAction: (registration) => {
            registrations.header = registration.component;
          },
        },
      });
      return {};
    },
    useRpc: () => rpc,
    useRealtime: () => undefined,
    useBbNavigate: () => ({
      toThread: () => undefined,
      openThreadPanel: () => true,
    }),
  },
};

await import("./app.js");

createRoot(document.getElementById("header")).render(
  React.createElement(registrations.header, { threadId: "thr_1" }),
);
createRoot(document.getElementById("panel")).render(
  React.createElement(registrations.panel, { threadId: "thr_1", params: null }),
);
`;

const outDir = await mkdtemp(join(tmpdir(), "bb-amp-preview-"));
await writeFile(join(outDir, "harness.jsx"), HARNESS);
await copyFile(join(root, "dist/app.js"), join(outDir, "app.js"));
await copyFile(join(root, "dist/app.css"), join(outDir, "app.css"));

await esbuild.build({
  entryPoints: [join(outDir, "harness.jsx")],
  bundle: true,
  format: "esm",
  outfile: join(outDir, "harness.js"),
  absWorkingDir: root,
  nodePaths: [join(root, "node_modules")],
  external: ["./app.js"],
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".jsx": "jsx" },
});

// BB theme variables the plugin stylesheet resolves against, taken from the
// app's light theme so the preview matches what the panel renders inside BB.
const THEME = `
:root {
  --background: oklch(0.99 0.002 260);
  --foreground: oklch(0.25 0.01 260);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.25 0.01 260);
  --primary: oklch(0.55 0.16 255);
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.96 0.004 260);
  --secondary-foreground: oklch(0.3 0.01 260);
  --muted: oklch(0.96 0.004 260);
  --muted-foreground: oklch(0.55 0.02 260);
  --border: oklch(0.9 0.006 260);
  --input: oklch(0.86 0.008 260);
  --ring: oklch(0.6 0.12 255);
  --destructive: oklch(0.58 0.2 25);
  --destructive-foreground: oklch(0.99 0 0);
  --attention: oklch(0.74 0.15 80);
  --success: oklch(0.7 0.15 155);
  --state-hover: color-mix(in oklab, oklch(0.25 0.01 260) 5.9%, transparent);
  --state-active: color-mix(in oklab, oklch(0.25 0.01 260) 11.8%, transparent);
  --radius: 0.5rem;
}
body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.panel-frame {
  width: ${panelWidth}px;
  border-left: 1px solid var(--border);
  padding: 12px;
  min-height: 100vh;
}
.header-frame { padding: 12px; border-bottom: 1px solid var(--border); }
`;

await writeFile(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
/* The BB app applies a Tailwind preflight globally and the plugin stylesheet
   ships utilities only, so the preview reproduces the parts that matter — in
   a layer declared first, so plugin utilities still win. */
@layer preview-base, theme, utilities;
@layer preview-base {
  button, textarea, input, a {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    margin: 0;
    text-align: inherit;
    text-decoration: none;
  }
  h2, h3, p, dl, dd, dt { margin: 0; }
  svg { display: block; }
}
</style>
<link rel="stylesheet" href="./app.css" />
<style>${THEME}</style>
</head>
<body>
<!-- The built stylesheet is @scope-d to the plugin root BB renders. -->
<div class="header-frame" data-bb-plugin="amp"><div id="header"></div></div>
<div class="panel-frame" data-bb-plugin="amp"><div id="panel"></div></div>
<script>
// Surface harness failures in the screenshot instead of a blank panel.
const report = (text) => {
  document.getElementById("panel").textContent = text;
};
addEventListener("error", (event) => report(\`ERROR: \${event.message}\`));
addEventListener("unhandledrejection", (event) =>
  report(\`REJECTED: \${event.reason?.stack ?? event.reason}\`),
);
</script>
<script type="module" src="./harness.js"></script>
</body></html>`,
);

// Chrome refuses ES module scripts over file://, so the page is served from
// a short-lived loopback server.
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css" };
const server = createServer((request, response) => {
  const name = request.url === "/" ? "index.html" : request.url.slice(1);
  readFile(join(outDir, name)).then(
    (body) => {
      response.writeHead(200, {
        "content-type": TYPES[name.split(".").pop()] ?? "text/plain",
        // Keep-alive sockets make Chrome's virtual time budget wait.
        connection: "close",
      });
      response.end(body);
    },
    () => {
      response.writeHead(404).end();
    },
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const page = `http://127.0.0.1:${server.address().port}/`;
console.log(`${page}  (${outDir})`);

if (screenshotPath === null) {
  console.log(
    "Serving until interrupted; pass --screenshot <path> to capture.",
  );
} else {
  const chrome = ["google-chrome", "chromium-browser", "chromium"].find(
    (binary) => spawnSync("which", [binary]).status === 0,
  );
  if (chrome === undefined)
    throw new Error("No local Chrome to screenshot with.");
  // Async spawn: a synchronous one would block the loop that serves the page.
  const status = await new Promise((resolve) => {
    const child = spawn(
      chrome,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        `--user-data-dir=${join(outDir, "chrome-profile")}`,
        `--window-size=${panelWidth + 40},1100`,
        "--virtual-time-budget=4000",
        `--screenshot=${screenshotPath}`,
        page,
      ],
      { stdio: "ignore" },
    );
    child.on("exit", resolve);
  });
  server.close();
  if (status !== 0) throw new Error("Chrome failed to render the page.");
  console.log(screenshotPath);
}
