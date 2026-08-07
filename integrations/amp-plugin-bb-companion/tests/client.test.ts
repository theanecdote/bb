import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("companion host client", () => {
  it("keeps the terminal alive until BB can collect the response frame", async () => {
    const secret = "s".repeat(32);
    const server = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ threadId: "T-test", state: "idle" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP test server.");
    }

    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "bb-companion-client.mjs")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });

    try {
      await waitFor(() => output.includes("BB_AMP_READY"));
      const input = {
        method: "GET",
        path: "/v1/threads/T-test/messages?offset=20",
        port: address.port,
        secret,
      };
      child.stdin.write(
        `${Buffer.from(JSON.stringify(input)).toString("base64")}\n`,
      );
      await waitFor(() => output.includes("BB_AMP_RESPONSE:"));

      const encoded = output
        .split("BB_AMP_RESPONSE:", 2)[1]
        .split(/\r?\n/, 1)[0];
      const response = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      assert.deepEqual(response, {
        ok: true,
        status: 200,
        body: { threadId: "T-test", state: "idle" },
      });
      assert.equal(child.exitCode, null);
    } finally {
      const childClosed = once(child, "close");
      const serverClosed = once(server, "close");
      child.kill();
      server.close();
      await Promise.allSettled([childClosed, serverClosed]);
    }
  });
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for output.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
