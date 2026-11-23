import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/config.js";
import { MariaDbStorage } from "../src/mariadb-storage.js";
import { buildTransactionReviews } from "../src/transaction-review.js";

const enabled = process.env.FINUP_TEST_MARIADB === "1";
const root = fileURLToPath(new URL("../", import.meta.url));

async function withDatabase(action) {
  await loadEnv(root);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST), "Temporary-table integration tests only connect locally");
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST === "localhost" ? "127.0.0.1" : process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASS || "", multipleStatements: true, decimalNumbers: true, connectTimeout: 5000
  });
  const wrapper = {
    execute: connection.execute.bind(connection), beginTransaction: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection), rollback: connection.rollback.bind(connection), release() {}
  };
  const storage = new MariaDbStorage({});
  storage.pool = { getConnection: async () => wrapper, execute: wrapper.execute };
  storage.setContext(1, 1);
  try {
    await connection.query(await readFile(new URL("./fixtures/transaction-move.sql", import.meta.url), "utf8"));
    await action({ connection, storage, wrapper });
  } finally { await connection.end(); }
}

test("MariaDB transfer preserves series, remaps wallets and follows documents through repeated moves", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage, wrapper }) => {
    const [before] = await connection.execute("SELECT * FROM transactions WHERE id IN (101,102) ORDER BY id");
    const result = await storage.moveTransactionsToControl({ ids: ["101"], destinationControlId: "2" });
    assert.deepEqual(result, { movedCount: 2, movedDocumentCount: 1, unassignedWalletCount: 0, destinationName: "Casa" });
    const [after] = await connection.execute("SELECT * FROM transactions WHERE id IN (101,102) ORDER BY id");
    assert.deepEqual(after, before.map((row) => ({ ...row, control_id: 2, account_id: 21, category_id: 21 })));
    const [[foreign]] = await connection.execute("SELECT control_id FROM transactions WHERE id=105");
    assert.equal(foreign.control_id, 4);

    storage.setContext(1, 2);
    const returned = await storage.moveTransactionsToControl({ ids: ["102"], destinationControlId: "1" });
    assert.equal(returned.movedDocumentCount, 1);
    const [[document]] = await connection.execute("SELECT control_id, stored_name FROM documents WHERE id=201");
    assert.equal(document.control_id, 1);
    assert.equal(document.stored_name, "gs://test/controls/1/school.pdf");

    storage.setContext(1, 1);
    await connection.beginTransaction();
    await storage.requestContext.run({ pool: wrapper, userId: 1, controlId: 1 }, () => storage.moveTransactionsToControl({ ids: ["101"], destinationControlId: "2" }));
    await connection.rollback();
    const [[rolledBack]] = await connection.execute("SELECT control_id FROM transactions WHERE id=101");
    assert.equal(rolledBack.control_id, 1, "A chat move must not commit its outer capture transaction");
    const unmatched = await storage.moveTransactionsToControl({ ids: ["103"], destinationControlId: "2" });
    assert.equal(unmatched.unassignedWalletCount, 1);
    assert.equal(unmatched.movedDocumentCount, 0, "A document shared with another source item stays in its original space");
    const [[category]] = await connection.execute("SELECT c.name, t.account_id FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=103");
    assert.equal(category.name, "Mercado");
    assert.equal(category.account_id, null);
    const final = await storage.moveTransactionsToControl({ ids: ["104"], destinationControlId: "2", walletMode: "specific", destinationAccountId: "22" });
    assert.equal(final.movedDocumentCount, 1);
    const [[pending]] = await connection.execute("SELECT control_id, account_id, status FROM transactions WHERE id=104");
    assert.deepEqual(pending, { control_id: 2, account_id: 22, status: "pending" });
  });
});

test("MariaDB transfer rejects missing membership, viewer roles and a wallet from another space", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage }) => {
    for (const destinationControlId of ["3", "4"]) {
      await assert.rejects(storage.moveTransactionsToControl({ ids: ["101"], destinationControlId }), { status: 403 });
    }
    await assert.rejects(storage.moveTransactionsToControl({ ids: ["101"], destinationControlId: "2", walletMode: "specific", destinationAccountId: "11" }), { status: 400 });
    await assert.rejects(storage.moveTransactionsToControl({ ids: ["101", "105"], destinationControlId: "2" }), { status: 404 });
    storage.setContext(2, 1);
    await assert.rejects(storage.moveTransactionsToControl({ ids: ["101"], destinationControlId: "2" }), { status: 403 });
    const [[item]] = await connection.execute("SELECT control_id, account_id FROM transactions WHERE id=101");
    assert.deepEqual(item, { control_id: 1, account_id: 11 });
  });
});

test("MariaDB transfer rolls back all items when a later write fails", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage, wrapper }) => {
    const execute = wrapper.execute;
    let updates = 0;
    wrapper.execute = async (sql, args) => {
      if (sql.startsWith("UPDATE transactions") && ++updates === 2) throw new Error("Simulated second-write failure");
      return execute(sql, args);
    };
    await assert.rejects(storage.moveTransactionsToControl({ ids: ["101"], destinationControlId: "2" }), /second-write failure/);
    const [items] = await connection.execute("SELECT control_id, account_id FROM transactions WHERE id IN (101,102)");
    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.control_id === 1 && item.account_id === 11));
  });
});

test("PHP performs the same transactional moves against isolated MariaDB tables", { skip: !enabled }, async () => {
  await loadEnv(root);
  const result = spawnSync("php", [fileURLToPath(new URL("./php-transaction-move-harness.php", import.meta.url))], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { series: true, repeatedDocumentMove: true, category: true, viewer: true, wallet: true, rollback: true });
});

async function reviewCapture(connection) {
  await connection.execute("INSERT INTO transactions (id,control_id,user_id,category_id,kind,status,description,amount,transaction_date,due_date,source,confidence) VALUES (106,1,1,12,'expense','pending','Mercado',100,'2026-11-10',NULL,'upload',0.72),(107,1,1,12,'expense','pending','Taxi',35,'2026-11-20','2026-11-20','manual',1)");
  await connection.execute("INSERT INTO documents (id,control_id,user_id,original_name,stored_name,content_hash,status) VALUES (301,1,1,'Mercado.pdf','private/market.pdf',?,'review_pending')", ["b".repeat(64)]);
}

test("MariaDB review blocks an entire capture until its duplicate candidates are acknowledged", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage }) => {
    await reviewCapture(connection);
    await storage.linkTransactionDocument("106", "301");
    const review = buildTransactionReviews(await storage.read()).get("106");
    assert.deepEqual(review.duplicateIds, ["103"]);
    assert.equal(review.documents[0].id, "301");
    assert.equal(review.issues[0].code, "check_interpretation");
    assert.deepEqual(await storage.confirmTransactions(["106", "107"]), { confirmedCount: 0, reviewRequired: true });
    const [pending] = await connection.execute("SELECT status FROM transactions WHERE id IN (106,107)");
    assert.ok(pending.every((item) => item.status === "pending"));
    assert.deepEqual(await storage.confirmTransactions(["106", "107"], ["103"]), { confirmedCount: 2, reviewRequired: false });
    const [confirmed] = await connection.execute("SELECT id,status FROM transactions WHERE id IN (106,107) ORDER BY id");
    assert.deepEqual(confirmed, [{ id: 106, status: "confirmed" }, { id: 107, status: "scheduled" }]);
    assert.deepEqual(await storage.confirmTransactions(["106", "107"]), { confirmedCount: 0, reviewRequired: false });
    const [[messageCount]] = await connection.execute("SELECT COUNT(*) AS count FROM chat_messages");
    assert.equal(messageCount.count, 1);
    storage.setContext(2, 1);
    await assert.rejects(storage.confirmTransactions(["104"]), { status: 403 });
    storage.setContext(1, 1);
    await assert.rejects(storage.confirmTransactions(["105"]), { status: 404 });
  });
});

test("MariaDB review detects candidates created after the user opened the capture", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage }) => {
    await reviewCapture(connection);
    await connection.execute("INSERT INTO transactions (id,control_id,user_id,category_id,kind,status,description,amount,transaction_date) VALUES (108,1,1,12,'expense','confirmed','Mercado',100,'2026-11-10')");
    const result = await storage.confirmTransactions(["106", "107"], ["103"]);
    assert.equal(result.reviewRequired, true);
    const [[other]] = await connection.execute("SELECT status FROM transactions WHERE id=107");
    assert.equal(other.status, "pending");
  });
});

test("MariaDB confirmation rolls back the entire capture if its final write fails", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage, wrapper }) => {
    await reviewCapture(connection);
    const execute = wrapper.execute;
    wrapper.execute = async (sql, args) => {
      if (sql.includes("INSERT INTO chat_messages")) throw new Error("Simulated confirmation failure");
      return execute(sql, args);
    };
    await assert.rejects(storage.confirmTransactions(["106", "107"], ["103"]), /confirmation failure/);
    const [rows] = await connection.execute("SELECT status FROM transactions WHERE id IN (106,107)");
    assert.ok(rows.every((item) => item.status === "pending"));
  });
});

test("document-link backfill is repeatable and cannot link another space's records", { skip: !enabled }, async () => {
  await withDatabase(async ({ connection, storage }) => {
    await connection.execute("DELETE FROM transaction_documents");
    await connection.execute("INSERT INTO capture_requests (control_id,user_id,operation,capture_data) VALUES (1,1,'upload',?)", [JSON.stringify({ transactionIds: ["105"], documentId: "201" })]);
    await storage.backfillDocumentLinks();
    await storage.backfillDocumentLinks();
    await storage.linkTransactionDocument("105", "201");
    const [links] = await connection.execute("SELECT transaction_id,document_id FROM transaction_documents ORDER BY transaction_id");
    assert.deepEqual(links, [{ transaction_id: 101, document_id: 201 }, { transaction_id: 102, document_id: 201 }, { transaction_id: 103, document_id: 202 }, { transaction_id: 104, document_id: 202 }]);
    await storage.moveTransactionsToControl({ ids: ["101"], destinationControlId: "2" });
    storage.setContext(1, 2);
    const moved = (await storage.read()).transactions.find((item) => item.id === "101");
    assert.deepEqual(moved.documentIds, ["201"]);
  });
});

test("PHP confirms reviewed captures atomically with scoped document links", { skip: !enabled }, async () => {
  await loadEnv(root);
  const result = spawnSync("php", [fileURLToPath(new URL("./php-transaction-review-harness.php", import.meta.url))], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { duplicates: true, atomic: true, idempotent: true, stale: true, scope: true, links: true });
});
