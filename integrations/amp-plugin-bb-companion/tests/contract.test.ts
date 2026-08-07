import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchRoute,
  parseConfig,
  validateCreate,
  validateMessage,
} from "../bb-companion.ts";

const config = parseConfig({
  enabled: true,
  secret: "x".repeat(32),
  allowedRunners: ["exe-roster"],
  maxMessageBytes: 128,
});

describe("companion contract", () => {
  it("parses allow-listed configuration", () => {
    assert.equal(config.enabled, true);
    assert.equal(config.control, true);
    assert.deepEqual(config.allowedRunners, ["exe-roster"]);
    assert.equal(config.port, 43931);
  });

  it("accepts create requests for allowed runners", () => {
    const input = validateCreate(
      {
        requestId: "req-1234",
        runnerId: "exe-roster",
        mode: "high",
        message: "Plan only.",
      },
      config,
    );
    assert.equal(input.runnerId, "exe-roster");
    assert.equal(input.mode, "high");
  });

  it("rejects disallowed runners", () => {
    assert.throws(
      () =>
        validateCreate(
          {
            requestId: "req-1234",
            runnerId: "other",
            mode: "high",
            message: "Plan only.",
          },
          config,
        ),
      /Runner is not allowed/,
    );
  });

  it("rejects oversized follow-up messages", () => {
    assert.throws(
      () => validateMessage({ message: "x".repeat(129) }, config),
      /Invalid message/,
    );
  });

  it("matches only narrow thread endpoints", () => {
    assert.deepEqual(matchRoute("POST", "/v1/threads"), { kind: "create" });
    assert.deepEqual(matchRoute("GET", "/v1/threads/T-abc123"), {
      kind: "get",
      threadId: "T-abc123",
    });
    assert.equal(matchRoute("POST", "/run-shell"), null);
    assert.equal(matchRoute("GET", "/v1/threads/not-a-thread"), null);
  });
});
