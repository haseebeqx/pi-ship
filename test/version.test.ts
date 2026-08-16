import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, validateVersion } from "../src/version.js";

test("runtime versions use semantic version precedence", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0+local", "1.0.0+server"), 0);
});

test("invalid runtime versions are rejected", () => {
  assert.throws(() => validateVersion("1.0"), /Invalid runtime version/);
  assert.throws(() => validateVersion("v1.0.0"), /Invalid runtime version/);
});
