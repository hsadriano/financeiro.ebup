import test from "node:test";
import assert from "node:assert/strict";
import { monthlyOccurrences, normalizeTransactionInput, validDate } from "../src/transaction-input.js";

const input = { amount: "1.234,56", kind: "expense", description: "Escola", transactionDate: "2026-01-31", dueDate: "2026-01-31", repeatCount: 3 };
test("manual entries parse Brazilian amounts without AI", () => {
  assert.equal(normalizeTransactionInput(input).amount, 1234.56);
});
test("monthly repetition clamps dates and links every occurrence", () => {
  const items = monthlyOccurrences(input, "series");
  assert.deepEqual(items.map((item) => item.dueDate), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.deepEqual(items.map((item) => item.recurrenceIndex), [1, 2, 3]);
  assert.ok(items.every((item) => item.status === "pending" && item.recurrenceGroupId === "series"));
});
test("invalid dates, values and unbounded recurrence are rejected", () => {
  assert.throws(() => validDate("2026-02-31"));
  assert.throws(() => normalizeTransactionInput({ ...input, amount: "15 reais" }));
  assert.throws(() => normalizeTransactionInput({ ...input, amount: "Infinity" }));
  assert.throws(() => monthlyOccurrences({ ...input, repeatCount: 1000 }, "series"));
  assert.throws(() => monthlyOccurrences({ ...input, repeatCount: 2.5 }, "series"));
  assert.throws(() => monthlyOccurrences({ ...input, repeatCount: 0 }, "series"));
});
test("repeating an already paid item does not mark future months as paid", () => {
  const items = monthlyOccurrences({ ...input, dueDate: null }, "series");
  assert.equal(items[0].dueDate, null);
  assert.equal(items[1].dueDate, "2026-02-28");
  assert.equal(items[2].dueDate, "2026-03-31");
});
