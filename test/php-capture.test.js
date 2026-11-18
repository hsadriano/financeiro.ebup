import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("PHP receipt transaction supports replay, rollback and user scoping", (t) => {
  const result = spawnSync("php", [fileURLToPath(new URL("./php-capture-harness.php", import.meta.url))], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("PHP runtime unavailable"); return; }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { replay: true, conflict: true, rollback: true, scope: true });
});
