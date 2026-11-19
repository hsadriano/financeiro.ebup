import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTransactions, runFinancialAssistant } from "../src/assistant.js";
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

test("settled queries match realized totals and exclude future bills", () => {
  const result = analyzeTransactions([...transactions, { ...transactions[1], id: "paid", amount: 80, status: "paid" }], {
    kind: "expense", status: "settled", date_basis: "transaction", start_date: "2026-08-01", end_date: "2026-09-30"
  });
  assert.equal(result.summary.expenses, 200);
  assert.equal(result.summary.count, 2);
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

test("only offers a chat move after finding the transaction and an editable destination", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const requests = [];
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const output = requests.length === 1
      ? [{ type: "function_call", name: "query_finances", call_id: "query-1", arguments: JSON.stringify({
          kind: "expense", status: "all", date_basis: "auto", start_date: null, end_date: null,
          category: null, search: "supermercado", account_name: null, group_by: "none", limit: 20
        }) }]
      : [{ type: "function_call", name: "move_transactions", call_id: "move-1", arguments: JSON.stringify({
          transaction_ids: ["2"], recurrence_group_id: null, destination_control_id: "12", destination_account_name: null
        }) }];
    return { ok: true, json: async () => ({ output }) };
  };

  try {
    const result = await runFinancialAssistant({
      message: "Mova o supermercado para Casa",
      history: [],
      transactions,
      wallets: [],
      controls: [{ id: "10", name: "Atual", role: "owner" }, { id: "12", name: "Casa", role: "editor" }],
      activeControlId: "10",
      now: new Date("2026-11-18T12:00:00Z")
    });
    assert.equal(result.kind, "move_transactions");
    assert.equal(result.destinationControlId, "12");
    assert.equal(result.transactionIds[0], "2");
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("assistant refuses a move to a viewer-only space", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => {
    calls += 1;
    const output = calls === 1
      ? [{ type: "function_call", name: "query_finances", call_id: "query-1", arguments: JSON.stringify({
          kind: "expense", status: "all", date_basis: "auto", start_date: null, end_date: null,
          category: null, search: "supermercado", account_name: null, group_by: "none", limit: 20
        }) }]
      : [{ type: "function_call", name: "move_transactions", call_id: "move-1", arguments: JSON.stringify({
          transaction_ids: ["2"], recurrence_group_id: null, destination_control_id: "12", destination_account_name: null
        }) }];
    return { ok: true, json: async () => ({ output }) };
  };

  try {
    const result = await runFinancialAssistant({
      message: "Mova o supermercado para Casa", history: [], transactions, wallets: [],
      controls: [{ id: "10", name: "Atual", role: "owner" }, { id: "12", name: "Casa", role: "viewer" }],
      activeControlId: "10", now: new Date("2026-11-18T12:00:00Z")
    });
    assert.equal(result.kind, "answer");
    assert.match(result.answer, /destino disponível/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("assistant refuses to move an identifier that was not queried", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ output: [{
    type: "function_call", name: "move_transactions", call_id: "move-1", arguments: JSON.stringify({
      transaction_ids: ["2"], recurrence_group_id: null, destination_control_id: "12", destination_account_name: null
    })
  }] }) });
  try {
    const result = await runFinancialAssistant({
      message: "Mova o supermercado para Casa", history: [], transactions,
      controls: [{ id: "10", name: "Atual", role: "owner" }, { id: "12", name: "Casa", role: "editor" }],
      activeControlId: "10"
    });
    assert.equal(result.kind, "answer");
    assert.match(result.answer, /localizar com segurança/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
