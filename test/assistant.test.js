import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTransactions } from "../src/assistant.js";
import { normalizeAssistantTransactions } from "../src/parser.js";

const transactions = [
  { id: "1", kind: "income", status: "confirmed", amount: 5000, description: "Salário", category: "Renda", transactionDate: "2026-08-05", dueDate: null },
  { id: "2", kind: "expense", status: "confirmed", amount: 120, description: "Supermercado", merchant: "Mercadinho", category: "Mercado", transactionDate: "2026-08-10", dueDate: null },
  { id: "3", kind: "expense", status: "scheduled", amount: 150, description: "Internet", category: "Moradia", transactionDate: "2026-09-25", dueDate: "2026-09-25" },
  { id: "4", kind: "expense", status: "pending", amount: 999, description: "Ainda não confirmado", category: "Outros", transactionDate: "2026-09-10", dueDate: null }
];

test("summarizes confirmed transactions by month and ignores pending items", () => {
  const result = analyzeTransactions(transactions, {
    kind: "all",
    status: "all",
    date_basis: "auto",
    start_date: "2026-08-01",
    end_date: "2026-09-30",
    category: null,
    search: null,
    group_by: "month",
    limit: 20
  });

  assert.deepEqual(result.summary, { count: 3, income: 5000, expenses: 270, result: 4730 });
  assert.deepEqual(result.groups.map((group) => group.key), ["2026-08", "2026-09"]);
});

test("uses due dates for upcoming payable queries", () => {
  const result = analyzeTransactions(transactions, {
    kind: "expense",
    status: "scheduled",
    date_basis: "due",
    start_date: "2026-09-20",
    end_date: "2026-09-30",
    category: null,
    search: "internet",
    group_by: "none",
    limit: 20
  });

  assert.equal(result.summary.count, 1);
  assert.equal(result.summary.expenses, 150);
  assert.equal(result.items[0].due_date, "2026-09-25");
});

test("normalizes month-based recurrence even when proposed dates are weekly", () => {
  const proposed = Array.from({ length: 3 }, (_, index) => ({
    kind: "expense",
    amount: 120,
    description: "Internet",
    merchant: null,
    paymentMethod: null,
    transactionDate: ["2026-09-30", "2026-10-07", "2026-10-14"][index],
    dueDate: ["2026-09-30", "2026-10-07", "2026-10-14"][index],
    category: "Moradia",
    confidence: 0.9
  }));

  const normalized = normalizeAssistantTransactions(
    proposed,
    "Internet de R$ 120 na próxima quarta por 3 meses",
    new Date("2026-09-23T12:00:00Z")
  );

  assert.deepEqual(normalized.map((item) => item.dueDate), ["2026-09-30", "2026-10-30", "2026-11-30"]);
});
