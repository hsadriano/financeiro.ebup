import test from "node:test";
import assert from "node:assert/strict";
import { expandMoveRows, matchMoveWallet, normalizeMoveName } from "../src/transaction-move.js";

const rows = [
  { id: "1", status: "confirmed", recurrenceGroupId: "school-fee" },
  { id: "2", status: "scheduled", recurrenceGroupId: "school-fee" },
  { id: "3", status: "paid", recurrenceGroupId: null }
];

test("moving one occurrence expands to every item in its recurrence series", () => {
  assert.deepEqual(expandMoveRows(rows, ["1"]).map((row) => row.id), ["1", "2"]);
});

test("series previews include linked drafts but never dismissed occurrences", () => {
  const all = [...rows, { id: "4", status: "pending", recurrenceGroupId: "school-fee" }, { id: "5", status: "dismissed", recurrenceGroupId: "school-fee" }];
  assert.deepEqual(expandMoveRows(all, ["1"]).map((row) => row.id), ["1", "2", "4"]);
  assert.throws(() => expandMoveRows(all, ["5"]), { status: 404 });
});

test("moving separate items expands each selected recurrence series only once", () => {
  assert.deepEqual(expandMoveRows(rows, ["2", "3"]).map((row) => row.id), ["1", "2", "3"]);
});

test("rejects transaction identifiers that do not belong to the source space", () => {
  assert.throws(() => expandMoveRows(rows, ["404"]), { status: 404 });
});

test("matches wallets accent-insensitively and reports ambiguous names", () => {
  assert.equal(normalizeMoveName("  Poupança  "), "poupanca");
  assert.equal(matchMoveWallet("Poupança", [{ id: "8", name: "Poupanca" }]).wallet.id, "8");
  assert.equal(matchMoveWallet("Conta", [{ name: "Conta" }, { name: "conta" }]).ambiguous, true);
});
