import test from "node:test";
import assert from "node:assert/strict";
import { MariaDbStorage } from "../src/mariadb-storage.js";

test("confirmed entries can be edited within the active shared control", async () => {
  const storage = new MariaDbStorage({});
  storage.setContext(1, 42);
  storage.ensureCategory = async () => 9;
  const calls = [];
  storage.pool = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.trim().startsWith("SELECT")) return [[{ id: "10", status: "confirmed", amount: 25, transactionDate: "2026-11-18", dueDate: null, createdAt: "2026-11-18T12:00:00Z" }]];
      return [{ affectedRows: 1 }];
    }
  };
  const changes = { kind: "expense", category: "Mercado", amount: 25, description: "Pão", merchant: null, paymentMethod: null, accountId: null, transactionDate: "2026-11-18", dueDate: null, status: "confirmed" };
  const updated = await storage.updateTransaction("10", changes);
  assert.equal(updated.amount, 25);
  assert.match(calls[0].sql, /control_id = \?/);
  assert.match(calls[0].sql, /status <> 'dismissed'/);
  assert.doesNotMatch(calls[0].sql, /status = 'pending'/);
  assert.deepEqual(calls[0].params.slice(-3), ["confirmed", "10", 42]);
  assert.equal((calls[0].sql.match(/\?/g) || []).length, calls[0].params.length);
});
