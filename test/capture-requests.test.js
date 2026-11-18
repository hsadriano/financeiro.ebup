import test from "node:test";
import assert from "node:assert/strict";
import { captureKey, captureFingerprint, executeCapture } from "../src/capture-requests.js";
import { MariaDbStorage } from "../src/mariadb-storage.js";
import { LocalCaptures, localContext, remainingDraft, attemptBody } from "../public/local-captures.js";

class Connection {
  rows = new Map();
  financial = [];
  async beginTransaction() { this.backup = { rows: structuredClone(this.rows), financial: structuredClone(this.financial) }; }
  async commit() { this.backup = null; }
  async rollback() {
    if (this.backup) { this.rows = this.backup.rows; this.financial = this.backup.financial; this.backup = null; }
  }
  async execute(sql, params) {
    if (sql.startsWith("INSERT")) {
      const [user, control, key, operation, fingerprint] = params;
      const id = [user, control, key].join(":");
      if (this.rows.has(id)) throw Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY" });
      this.rows.set(id, { operation, fingerprint, capture_data: null });
    } else if (sql.startsWith("UPDATE")) {
      const [data, user, control, key] = params;
      this.rows.get([user, control, key].join(":")).capture_data = data;
    } else if (sql.startsWith("SELECT")) return [[this.rows.get(params.join(":"))].filter(Boolean)];
    return [{}];
  }
}
const receipt = { userId: 1, controlId: 2, key: "request-000000001", operation: "manual", fingerprint: "one" };
test("replaying a completed request does not create another transaction", async () => {
  const db = new Connection();
  let calls = 0;
  const action = async () => { calls++; db.financial.push("one"); return { capture: { transactionIds: ["one"] } }; };
  const replay = async () => ({ current: true });
  await executeCapture(db, receipt, action, replay);
  const result = await executeCapture(db, receipt, action, replay);
  assert.equal(calls, 1);
  assert.deepEqual(db.financial, ["one"]);
  assert.deepEqual(result.capture.transactionIds, ["one"]);
  assert.equal(result.capture.replayed, true);
});
test("failed work rolls back its receipt and financial changes before retry", async () => {
  const db = new Connection();
  await assert.rejects(executeCapture(db, receipt, async () => { db.financial.push("partial"); throw new Error("Interrupted"); }, async () => ({})));
  assert.equal(db.rows.size, 0);
  assert.equal(db.financial.length, 0);
  await executeCapture(db, receipt, async () => ({ capture: { transactionIds: ["retry"] } }), async () => ({}));
  assert.equal(db.rows.size, 1);
});
test("a reused key cannot silently change its payload or cross user/control boundaries", async () => {
  const db = new Connection();
  let calls = 0;
  const action = async () => { calls++; return { capture: { transactionIds: [String(calls)] } }; };
  await executeCapture(db, receipt, action, async () => ({}));
  await assert.rejects(executeCapture(db, { ...receipt, fingerprint: "changed" }, action, async () => ({})), { status: 409 });
  await executeCapture(db, { ...receipt, userId: 7 }, action, async () => ({}));
  await executeCapture(db, { ...receipt, controlId: 9 }, action, async () => ({}));
  assert.equal(calls, 3);
});
test("request context remains isolated across concurrent Node requests", async () => {
  const storage = new MariaDbStorage({});
  storage.setContext(100, 200);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const first = storage.runContext(async () => {
    storage.setContext(1, 11);
    await gate;
    return [storage.userId, storage.controlId];
  });
  const second = await storage.runContext(async () => {
    storage.setContext(2, 22); resume();
    await Promise.resolve();
    return [storage.userId, storage.controlId];
  });
  assert.deepEqual(await first, [1, 11]);
  assert.deepEqual(second, [2, 22]);
  assert.deepEqual([storage.userId, storage.controlId], [100, 200]);
});
test("local outbox reuses an unresolved attempt but permits identical new purchases after completion", async () => {
  const store = new LocalCaptures(null);
  const context = localContext("user", "home");
  const first = await store.enqueue(context, "/api/chat", { message: "Pão 15" });
  const retry = await store.enqueue(context, "/api/chat", { message: "Pão 15" });
  assert.equal(first.id, retry.id);
  await store.remove("outbox", first.id);
  assert.notEqual((await store.enqueue(context, "/api/chat", { message: "Pão 15" })).id, first.id);
});
test("local data does not appear in another user or control and logout clears only that user", async () => {
  const store = new LocalCaptures(null);
  await store.put("drafts", { context: localContext("a", "home"), text: "Private" });
  await store.enqueue(localContext("b", "home"), "/api/chat", { message: "B 10" });
  assert.equal(await store.draft(localContext("a", "work")), null);
  assert.equal(await store.draft(localContext("b", "home")), null);
  await store.clearUser("a");
  assert.equal((await store.all("drafts")).length, 0);
  assert.equal((await store.pending(localContext("b", "home"))).length, 1);
});
test("queued files can be rebuilt and draft previews do not repeat already queued text", async () => {
  const store = new LocalCaptures(null);
  const file = new File(["receipt"], "comprovante.png", { type: "image/png" });
  const body = new FormData(); body.append("file", file);
  const attempt = await store.enqueue("a:home", "/api/upload", body, true);
  assert.equal(attemptBody(attempt).get("file").name, "comprovante.png");
  assert.equal(await attemptBody(attempt).get("file").text(), "receipt");
  const visible = remainingDraft({ text: "Pão 15", chatText: "Pergunta ainda não enviada", manual: {} }, [{ url: "/api/chat", origin: "capture", payload: { message: "Pão 15" } }]);
  assert.equal(visible.text, "");
  assert.equal(visible.chatText, "Pergunta ainda não enviada");
});
test("keys and fingerprints reject ambiguous reuse", () => {
  assert.throws(() => captureKey("../../not-a-key"));
  assert.equal(captureKey(null), null);
  assert.notEqual(captureFingerprint("chat", { message: "15" }), captureFingerprint("chat", { message: "20" }));
});
