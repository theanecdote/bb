import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { parseHostClientOutput, requestThroughHost } from "../host-client";

describe("Amp enrolled-host client", () => {
  it("parses only framed base64 JSON", () => {
    const response = { ok: true, status: 200, body: { state: "idle" } };
    const encoded = Buffer.from(JSON.stringify(response)).toString("base64");
    assert.deepEqual(
      parseHostClientOutput(`shell noise\r\nBB_AMP_RESPONSE:${encoded}\r\n`),
      response,
    );
    assert.equal(parseHostClientOutput("shell noise"), null);
  });

  it("waits for readiness, sends one request, and closes the terminal", async () => {
    const response = { ok: true, status: 201, body: { threadId: "T-one" } };
    const encodedResponse = Buffer.from(JSON.stringify(response)).toString(
      "base64",
    );
    let outputCalls = 0;
    let sent = "";
    let closed = false;
    const bb = {
      sdk: {
        terminals: {
          create: async () => ({ id: "term-1" }),
          output: async () => {
            outputCalls += 1;
            const text =
              outputCalls === 1
                ? "BB_AMP_READY\r\n"
                : `BB_AMP_RESPONSE:${encodedResponse}\r\n`;
            return {
              chunks: [
                {
                  seq: outputCalls,
                  dataBase64: Buffer.from(text).toString("base64"),
                },
              ],
              nextSeq: outputCalls,
              truncated: false,
            };
          },
          input: async ({ dataBase64 }: { dataBase64: string }) => {
            sent = Buffer.from(dataBase64, "base64").toString("utf8");
          },
          close: async () => {
            closed = true;
          },
        },
      },
    } as unknown as BbPluginApi;

    const result = await requestThroughHost(
      bb,
      "host-1",
      "/home/user/.config/amp/plugins/bb-companion-client.mjs",
      {
        method: "GET",
        path: "/v1/threads/T-one",
        port: 43931,
        secret: "a".repeat(32),
      },
    );

    assert.deepEqual(result, response);
    assert.match(sent, /\n$/);
    assert.equal(closed, true);
  });
});
