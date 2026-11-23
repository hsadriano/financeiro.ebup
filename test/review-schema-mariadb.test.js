import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnv } from "../src/config.js";
import { MariaDbStorage } from "../src/mariadb-storage.js";

test("Node and PHP migrations and HTTP confirmation preserve reviewed captures", { skip: process.env.FINUP_TEST_MARIADB !== "1" }, async () => {
  await loadEnv(fileURLToPath(new URL("../", import.meta.url)));
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST));
  const database = "finup_review_test_" + crypto.randomBytes(6).toString("hex");
  const config = { host: "127.0.0.1", port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASS || "" };
  const mysql = await import("mysql2/promise");
  const admin = await mysql.createConnection({ ...config, connectTimeout: 5000 });
  const storage = new MariaDbStorage({ ...config, database });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await storage.init();
    const transaction = await storage.addTransaction({ kind: "expense", status: "pending", amount: 15, description: "Pão de teste", category: "Mercado", transactionDate: "2026-11-19", dueDate: null, merchant: null, paymentMethod: null, source: "upload", rawText: "Teste", confidence: 0.7 });
    const document = await storage.addDocument({ originalName: "Pão.png", storedName: "private/receipt.png", mimeType: "image/png", status: "review_pending", contentHash: "a".repeat(64) });
    await storage.pool.execute("INSERT INTO capture_requests (user_id,control_id,request_key,operation,fingerprint,capture_data) VALUES (?,?,?,'upload',?,?)", [storage.userId, storage.controlId, "test-review-receipt", "b".repeat(64), JSON.stringify({ transactionIds: [transaction.id], documentId: document.id })]);

    async function restoreLegacySchema() {
      await storage.pool.execute("DROP TABLE transaction_documents");
      await storage.pool.execute("ALTER TABLE documents DROP COLUMN content_hash");
      await storage.pool.execute("DELETE FROM finup_schema_versions WHERE version = '20261119_smart_review_v2'");
    }
    await restoreLegacySchema();
    await storage.ensureReviewSchema();
    let state = await storage.read();
    assert.deepEqual(state.transactions[0].documentIds, [document.id]);
    assert.equal(state.transactions[0].status, "pending");
    assert.equal(state.transactions[0].amount, 15);
    await restoreLegacySchema();
    const php = spawnSync("php", [fileURLToPath(new URL("./php-review-schema-harness.php", import.meta.url))], { encoding: "utf8", env: { ...process.env, DB_HOST: config.host, DB_NAME: database } });
    assert.equal(php.status, 0, php.stderr || php.stdout);
    assert.deepEqual(JSON.parse(php.stdout), { migrated: true });
    state = await storage.read();
    assert.deepEqual(state.transactions[0].documentIds, [document.id]);
    assert.equal(state.transactions[0].description, "Pão de teste");
    const [keys] = await storage.pool.execute("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transaction_documents' AND REFERENCED_TABLE_NAME IS NOT NULL", [database]);
    assert.equal(keys.length, 2);
    await storage.ensureReviewSchema();
    assert.equal((await storage.read()).transactions.length, 1);
    for (const backend of ["node", "php"]) await checkReviewApi(backend, database, config, storage);
  } finally {
    if (storage.defaultPool) await storage.defaultPool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

async function checkReviewApi(backend, database, config, storage) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const env = { ...process.env, DB_HOST: config.host, DB_NAME: database, PORT: String(port), OPENAI_API_KEY: "disabled-for-tests" };
  let directory;
  if (backend === "php") {
    directory = await mkdtemp(path.join(tmpdir(), "finup-review-http-"));
    await mkdir(path.join(directory, "app"));
    for (const filename of ["api.php", "app/capture-requests.php", "app/transaction-review.php"]) await copyFile(path.join(root, filename), path.join(directory, filename));
    await copyFile(new URL("./fixtures/api-router.php", import.meta.url), path.join(directory, "router.php"));
    const values = { DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user, DB_PASS: config.password, DB_NAME: database };
    assert.ok(Object.values(values).every((value) => !/[\r\n]/.test(value)));
    await writeFile(path.join(directory, ".env"), Object.entries(values).map(([key, value]) => key + "=" + value).join("\n"), { mode: 0o600 });
  }
  const child = spawn(backend === "node" ? process.execPath : "php", backend === "node" ? ["src/server.js"] : ["-S", "127.0.0.1:" + port, "-t", directory, path.join(directory, "router.php")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const base = "http://127.0.0.1:" + port + "/api/";
  let cookie = "";
  async function api(route, data) {
    const response = await fetch(base + route, { method: data === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (spawnError || child.exitCode !== null) throw new Error(logs || spawnError?.message || "Test API stopped");
      try { if ((await api("session")).status === 200) break; } catch {}
      if (Date.now() >= deadline) throw new Error("Test API failed to start: " + logs);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const registration = await api("auth/register", { name: "Pessoa de teste HTTP", email: crypto.randomBytes(6).toString("hex") + "@example.test", password: "test-password-123", remember: false });
    assert.equal(registration.status, 200, JSON.stringify(registration.data));
    cookie = registration.cookie.split(";")[0];
    const input = { amount: "42", description: "Mensalidade HTTP de teste", transactionDate: "2026-11-19", dueDate: "2026-11-19", kind: "expense", paymentState: "scheduled", repeatCount: "3", category: "Educação" };
    const capture = await api("transactions", input);
    assert.equal(capture.status, 200);
    const ids = capture.data.capture.transactionIds;
    assert.equal(ids.length, 3);
    assert.equal((await api("transactions/confirm", { ids, reviewedDuplicateIds: [] })).status, 200);
    const duplicate = await api("transactions", { ...input, repeatCount: "1" });
    assert.equal(duplicate.status, 200);
    const duplicateId = duplicate.data.capture.transactionIds[0];
    const blocked = await api("transactions/confirm", { ids: [duplicateId], reviewedDuplicateIds: [] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, "duplicate_review_required");
    assert.equal((await api("transactions/" + duplicateId + "/confirm", {})).status, 409);
    assert.equal((await api("transactions/confirm", { ids: [{}] })).status, 400);
    assert.equal((await api("session")).status, 200, "Invalid confirmation must not stop the server");
    assert.equal((await api("transactions/confirm", { ids: [duplicateId], reviewedDuplicateIds: ids })).status, 200);
    storage.setContext(Number(registration.data.user.id), Number(registration.data.activeControlId));
    const attachment = await storage.addDocument({ originalName: "Recibo HTTP.png", storedName: "private/http-receipt.png", mimeType: "image/png", status: "review_pending", contentHash: "c".repeat(64) });
    await storage.linkTransactionDocument(duplicateId, attachment.id);
    const state = await api("state");
    assert.equal(state.data.transactions.find((item) => item.id === duplicateId).review.documents[0].id, attachment.id);
    assert.equal(state.data.documents[0].storedName, undefined);
    assert.equal(state.data.documents[0].contentHash, undefined);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
