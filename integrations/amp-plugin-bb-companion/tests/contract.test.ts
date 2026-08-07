import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cachedTranscriptPage,
  matchRoute,
  normalizeTranscript,
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
    assert.deepEqual(matchRoute("GET", "/v1/threads/T-abc123/messages"), {
      kind: "messages",
      threadId: "T-abc123",
    });
    assert.equal(matchRoute("POST", "/run-shell"), null);
    assert.equal(matchRoute("GET", "/v1/threads/not-a-thread"), null);
  });

  it("exposes only user and assistant text blocks", () => {
    assert.deepEqual(
      normalizeTranscript([
        {
          id: "M-user",
          role: "user",
          content: [
            { type: "text", text: "Question" },
            { type: "tool_result", toolUseID: "tool", status: "done" },
          ],
        },
        {
          id: "M-assistant",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Answer" },
            { type: "tool_use", id: "tool", name: "shell", input: {} },
          ],
        },
      ]),
      [
        { id: "M-user", role: "user", text: "Question" },
        { id: "M-assistant", role: "assistant", text: "Answer" },
      ],
    );
  });

  it("pages the bounded in-memory transcript from the newest messages", () => {
    const transcript = Array.from({ length: 25 }, (_, index) => ({
      id: `message-${index}`,
      role: (index % 2 === 0 ? "user" : "assistant") as
        | "user"
        | "assistant",
      text: `message ${index}`,
    }));
    const newest = cachedTranscriptPage(transcript, 0);
    assert.equal(newest.messages[0].id, "message-5");
    assert.equal(newest.messages.at(-1)?.id, "message-24");
    assert.equal(newest.nextOffset, 20);
    const earlier = cachedTranscriptPage(transcript, newest.nextOffset!);
    assert.equal(earlier.messages.length, 5);
    assert.equal(earlier.nextOffset, null);
  });
});
