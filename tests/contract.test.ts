import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSharedPortUrl,
  hashRemote,
  parseCompanionPort,
  parseConfig,
  selectTarget,
  truncate,
} from "../contract.ts";

describe("bb-plugin-amp contract helpers", () => {
  it("parses explicit target mappings", () => {
    const config = parseConfig(
      JSON.stringify({
        targets: [
          {
            name: "Roster Amp",
            runnerId: "exe-roster",
            bbHostId: "host_123",
            repoRoot: "/home/exedev/repos/roster",
          },
        ],
      }),
    );
    assert.equal(config.targets[0].runnerId, "exe-roster");
  });

  it("selects exactly one host/path target", () => {
    const target = {
      name: "Roster Amp",
      runnerId: "exe-roster",
      bbHostId: "host_123",
      repoRoot: "/home/exedev/repos/roster",
    };
    assert.equal(selectTarget([target], "host_123", "/home/exedev/repos/roster"), target);
    assert.equal(selectTarget([target], "host_999", "/home/exedev/repos/roster"), null);
    assert.equal(selectTarget([target, target], "host_123", "/home/exedev/repos/roster"), null);
  });

  it("hashes repo remotes without exposing the remote string", () => {
    const first = hashRemote("https://example.test/repo.git");
    const second = hashRemote("https://example.test/repo.git");
    assert.equal(first, second);
    assert.equal(first.length, 64);
  });

  it("bounds handoff text", () => {
    assert.equal(truncate("abc", 10), "abc");
    assert.match(truncate("abcdef", 3), /\[truncated\]$/);
  });

  it("builds the enrolled-host shared-port URL", () => {
    assert.equal(parseCompanionPort("43931"), 43931);
    assert.equal(
      buildSharedPortUrl("ice-by-snowboard", "getbb.app", 43931, "/v1/threads").toString(),
      "https://ice-by-snowboard--43931.getbb.app/v1/threads",
    );
    assert.throws(() => parseCompanionPort("0"), /valid TCP port/);
  });
});
