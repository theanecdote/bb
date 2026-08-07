import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { isAuthenticatedCompanionListening } from "../bb-companion.ts";

describe("companion process lifecycle", () => {
  it("recognizes only an existing listener with the same secret", async () => {
    const secret = "s".repeat(32);
    const server = createServer((request, response) => {
      const authenticated =
        request.headers.authorization === `Bearer ${secret}`;
      response.writeHead(authenticated ? 404 : 401, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          authenticated
            ? { code: "INVALID_REQUEST", message: "Unknown endpoint." }
            : { code: "UNAUTHORIZED", message: "Unauthorized." },
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP test server.");
    }

    try {
      assert.equal(
        await isAuthenticatedCompanionListening(address.port, secret),
        true,
      );
      assert.equal(
        await isAuthenticatedCompanionListening(address.port, "w".repeat(32)),
        false,
      );
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
