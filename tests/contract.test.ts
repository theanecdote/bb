import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashRemote,
  parseCompanionPort,
  parseConfig,
  selectTarget,
  truncate,
} from "../contract";

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
            companionClientPath:
              "/home/exedev/.config/amp/plugins/bb-companion-client.mjs",
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
      companionClientPath:
        "/home/exedev/.config/amp/plugins/bb-companion-client.mjs",
    };
    assert.equal(
      selectTarget([target], "host_123", "/home/exedev/repos/roster"),
      target,
    );
    assert.equal(
      selectTarget([target], "host_999", "/home/exedev/repos/roster"),
      null,
    );
    assert.equal(
      selectTarget([target, target], "host_123", "/home/exedev/repos/roster"),
      null,
    );
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

  it("validates the companion port", () => {
    assert.equal(parseCompanionPort("43931"), 43931);
    assert.throws(() => parseCompanionPort("0"), /valid TCP port/);
  });
});
