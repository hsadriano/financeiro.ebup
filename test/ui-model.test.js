import test from "node:test";
import assert from "node:assert/strict";
import { captureDrafts, groupDrafts, seriesTargets, filterLedger, settledTotals, localDate } from "../public/ui-model.js";

const entries = [
  { id: "1", kind: "expense", status: "confirmed", amount: 15, description: "Pão", category: "Mercado", transactionDate: "2026-11-17" },
  { id: "2", kind: "expense", status: "scheduled", amount: 900, description: "Escola", category: "Educação", transactionDate: "2026-11-20", dueDate: "2026-11-20", recurrenceGroupId: "school" },
  { id: "3", kind: "expense", status: "scheduled", amount: 900, description: "Escola", category: "Educação", transactionDate: "2026-12-20", dueDate: "2026-12-20", recurrenceGroupId: "school" },
  { id: "4", kind: "income", status: "paid", amount: 3000, description: "Salário", transactionDate: "2026-11-05" }
];
test("only presents drafts belonging to the current capture", () => {
  assert.deepEqual(captureDrafts({ pendingTransactions: [{ id: "old" }, { id: "new" }] }, ["new"]).map((item) => item.id), ["new"]);
});
test("groups recurring drafts without mixing unrelated entries", () => {
  assert.deepEqual(groupDrafts(entries).map((group) => group.map((item) => item.id)), [["1"], ["2", "3"], ["4"]]);
});
test("series edit honors one, next and all scopes", () => {
  assert.deepEqual(seriesTargets(entries, entries[2], "one").map((item) => item.id), ["3"]);
  assert.deepEqual(seriesTargets(entries, entries[2], "next").map((item) => item.id), ["3"]);
  assert.deepEqual(seriesTargets(entries, entries[2], "all").map((item) => item.id), ["2", "3"]);
});
test("realized summary excludes unpaid scheduled entries", () => {
  assert.deepEqual(settledTotals(entries, "2026-11"), { income: 3000, expenses: 15, result: 2985 });
});
test("ledger defaults to a month and supports accent-insensitive search", () => {
  const filters = { kind: "all", period: "current-month", category: "", wallet: "", search: "pao" };
  assert.deepEqual(filterLedger(entries, filters, new Date(2026, 10, 17)).map((item) => item.id), ["1"]);
  assert.equal(filterLedger(entries, { ...filters, search: "" }, new Date(2026, 10, 17)).length, 3);
});
test("local calendar dates do not shift with UTC", () => {
  assert.equal(localDate(new Date(2026, 10, 17, 23, 59)), "2026-11-17");
});
