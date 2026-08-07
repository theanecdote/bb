import { createInterface } from "node:readline";

const RESPONSE_MARKER = "BB_AMP_RESPONSE:";
const MAX_INPUT_BYTES = 256 * 1024;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write("BB_AMP_READY\n");
const timer = setTimeout(
  () =>
    finish({
      ok: false,
      status: 504,
      body: { code: "TIMEOUT", message: "Client input timed out." },
    }),
  5_000,
);

lines.once("line", async (line) => {
  clearTimeout(timer);
  try {
    if (Buffer.byteLength(line) > MAX_INPUT_BYTES)
      throw new Error("Input is too large.");
    const request = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
    validate(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const payload =
        request.body === undefined ? undefined : JSON.stringify(request.body);
      const response = await fetch(
        `http://127.0.0.1:${request.port}${request.path}`,
        {
          method: request.method,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${request.secret}`,
            accept: "application/json",
            ...(payload === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: payload }),
        },
      );
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error("Companion returned invalid JSON.");
      }
      finish({ ok: response.ok, status: response.status, body });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    finish({
      ok: false,
      status: error instanceof Error && error.name === "AbortError" ? 504 : 502,
      body: {
        code:
          error instanceof Error && error.name === "AbortError"
            ? "TIMEOUT"
            : "AMP_API_ERROR",
        message:
          error instanceof Error ? error.message : "Companion client failed.",
      },
    });
  }
});

function validate(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid request.");
  if (!["GET", "POST"].includes(value.method))
    throw new Error("Invalid method.");
  if (
    typeof value.path !== "string" ||
    !/^\/v1\/threads(?:\/T-[A-Za-z0-9_-]+(?:\/(?:messages|cancel))?)?$/.test(
      value.path,
    )
  )
    throw new Error("Invalid path.");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
    throw new Error("Invalid port.");
  if (typeof value.secret !== "string" || value.secret.length < 24)
    throw new Error("Invalid secret.");
}

function finish(value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  process.stdout.write(`${RESPONSE_MARKER}${encoded}\n`);
  process.exit(0);
}
