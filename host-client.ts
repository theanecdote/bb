import type { BbPluginApi } from "@bb/plugin-sdk";

const RESPONSE_MARKER = "BB_AMP_RESPONSE:";
const READY_MARKER = "BB_AMP_READY";

type HostRequest = {
  method: "GET" | "POST";
  path: string;
  port: number;
  secret: string;
  body?: unknown;
};

export async function requestThroughHost(
  bb: BbPluginApi,
  hostId: string,
  clientPath: string,
  request: HostRequest,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const terminal = await bb.sdk.terminals.create({
    cols: 80,
    rows: 24,
    scope: { kind: "host_path", hostId, cwd: null },
    start: {
      mode: "command",
      command: `stty -echo; exec node ${shellQuote(clientPath)}`,
    },
    title: "Amp companion request",
  });

  try {
    let sinceSeq = 0;
    let output = "";
    const readyDeadline = Date.now() + 10_000;
    while (!output.includes(READY_MARKER) && Date.now() < readyDeadline) {
      const next = await readOutput(bb, terminal.id, sinceSeq);
      sinceSeq = next.nextSeq;
      output += next.text;
      if (!output.includes(READY_MARKER)) await delay(50);
    }
    if (!output.includes(READY_MARKER)) {
      throw new Error("Companion host client did not become ready.");
    }

    const encoded = Buffer.from(JSON.stringify(request), "utf8").toString(
      "base64",
    );
    await bb.sdk.terminals.input({
      terminalId: terminal.id,
      dataBase64: Buffer.from(`${encoded}\n`, "utf8").toString("base64"),
    });

    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const next = await readOutput(bb, terminal.id, sinceSeq);
      sinceSeq = next.nextSeq;
      output += next.text;
      const response = parseHostClientOutput(output);
      if (response !== null) return response;
      await delay(100);
    }
    throw new Error("TIMEOUT: Companion request timed out.");
  } finally {
    await bb.sdk.terminals
      .close({ terminalId: terminal.id, mode: "force" })
      .catch(() => undefined);
  }
}

async function readOutput(
  bb: BbPluginApi,
  terminalId: string,
  sinceSeq: number,
) {
  const output = await bb.sdk.terminals.output({
    terminalId,
    sinceSeq,
    tailBytes: 256 * 1024,
    limitChunks: 1000,
  });
  return {
    nextSeq: output.nextSeq,
    text: output.chunks
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
      .join(""),
  };
}

export function parseHostClientOutput(output: string) {
  const markerIndex = output.lastIndexOf(RESPONSE_MARKER);
  if (markerIndex < 0) return null;
  const encoded = output
    .slice(markerIndex + RESPONSE_MARKER.length)
    .split(/\r?\n/, 1)[0]
    .trim();
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      ok: boolean;
      status: number;
      body: unknown;
    };
  } catch {
    throw new Error("Companion host client returned invalid JSON.");
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
