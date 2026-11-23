import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTransactionReviews, confirmationIds, unreviewedDuplicateIds, withTransactionReviews } from "../src/transaction-review.js";
import { normalizeAssistantTransactions } from "../src/parser.js";

const entry = (changes = {}) => ({ id: "1", status: "confirmed", kind: "expense", amount: 89.9, description: "Compra no Mercadinho São João", merchant: "Mercadinho São João", transactionDate: "2026-11-19", dueDate: null, category: "Mercado", source: "chat", confidence: 0.96, recurrenceGroupId: null, documentIds: [], ...changes });
const document = (id) => ({ id, originalName: "Mercadinho São João.png", mimeType: "image/png", status: "review_pending", contentHash: "a".repeat(64), storedName: "private/object.png", createdAt: "2026-11-19T12:00:00Z" });
const fixture = () => ({
  transactions: [
    entry({ documentIds: ["11"] }),
    entry({ id: "2", status: "pending", description: "Mercadinho Sao Joao", merchant: null, confidence: 0.72, category: "Outros", source: "upload", documentIds: ["12"] }),
    entry({ id: "3", status: "pending", transactionDate: "2026-11-20", source: "manual" }),
    entry({ id: "4", kind: "income" }),
    entry({ id: "5", amount: 20, description: "Cinema", merchant: null }),
    entry({ id: "6", amount: 20, status: "pending", description: "Uber", merchant: null, source: "manual" }),
    entry({ id: "7", amount: 900, status: "pending", description: "Escola (1/12)", merchant: null, recurrenceGroupId: "school" }),
    entry({ id: "8", amount: 900, description: "Escola (2/12)", merchant: null, recurrenceGroupId: "school" }),
    entry({ id: "9", status: "dismissed" }),
    entry({ id: "10", status: "pending", source: "manual", confidence: 0, category: "Outros", amount: 70, merchant: null, description: "Outra despesa" })
  ],
  documents: [document("11"), document("12")], wallets: [], messages: []
});

test("reviews show attached documents, uncertain extraction and unspecified categories", () => {
  const review = buildTransactionReviews(fixture()).get("2");
  assert.deepEqual(review.issues.map((issue) => issue.code), ["check_interpretation", "check_category"]);
  assert.deepEqual(review.issues[0].fields, ["amount", "date", "paymentState"]);
  assert.equal(review.documents[0].id, "12");
  assert.equal(review.documents[0].storedName, undefined);
  assert.equal(review.documents[0].contentHash, undefined);
  assert.equal(buildTransactionReviews(fixture()).get("1").issues.length, 0, "Already reviewed entries do not keep uncertainty warnings");
});

test("identical files are flagged even if OCR extracts different financial details", () => {
  const data = fixture();
  Object.assign(data.transactions[1], { amount: 130, transactionDate: "2026-10-01", kind: "income", description: "Leitura divergente" });
  const review = buildTransactionReviews(data).get("2");
  assert.deepEqual(review.duplicateIds, ["1"]);
  assert.equal(review.duplicates[0].reason, "same_document");
});

test("financial matching tolerates accents and generic purchase words without requiring a file", () => {
  const data = fixture();
  data.transactions[1].documentIds = [];
  const review = buildTransactionReviews(data).get("2");
  assert.deepEqual(review.duplicateIds, ["1"]);
  assert.equal(review.duplicates[0].reason, "matching_details");
});

test("does not confuse different dates, kinds, unrelated purchases or the same recurring series", () => {
  const reviews = buildTransactionReviews(fixture());
  for (const id of ["3", "6", "7", "10"]) assert.equal(reviews.get(id).needsAttention, false, id);
  assert.equal(reviews.has("9"), false);
  const data = { transactions: [entry({ description: "Compra", merchant: null }), entry({ id: "2", status: "pending", source: "manual", description: "Compra", merchant: null })], documents: [] };
  assert.deepEqual(buildTransactionReviews(data).get("2").duplicateIds, []);
});

test("acknowledgement must cover newly detected candidates, not just a stale list", () => {
  const data = fixture();
  assert.deepEqual(unreviewedDuplicateIds(data, ["2"]), ["1"]);
  assert.deepEqual(unreviewedDuplicateIds(data, ["2"], ["1"]), []);
  data.transactions.push(entry({ id: "15" }));
  assert.deepEqual(unreviewedDuplicateIds(data, ["2"], ["1"]), ["15"]);
});

test("keeps all candidate identifiers for acknowledgement while limiting verbose previews", () => {
  const data = fixture();
  data.transactions.push(...Array.from({ length: 8 }, (_, index) => entry({ id: String(20 + index) })));
  const review = buildTransactionReviews(data).get("2");
  assert.equal(review.duplicateIds.length, 9);
  assert.equal(review.duplicates.length, 3);
});

test("confirmation identifiers reject missing, malformed and unsafe selections", () => {
  assert.deepEqual(confirmationIds(["1", "1", "2"]), ["1", "2"]);
  for (const value of [[], [null], [NaN], [Number.MAX_SAFE_INTEGER + 1], ["1/confirm"], Array(101).fill("1")]) assert.throws(() => confirmationIds(value), { status: 400 });
});

test("invalid extractor confidence becomes a review warning instead of an invalid database number", () => {
  const [normalized] = normalizeAssistantTransactions([entry({ confidence: "unclear" })], "Gastei 89,90 no mercado", new Date("2026-11-19T12:00:00Z"));
  assert.equal(normalized.confidence, 0);
  const review = buildTransactionReviews({ transactions: [{ ...normalized, id: "1", status: "pending" }], documents: [] }).get("1");
  assert.equal(review.issues[0].code, "check_interpretation");
});

test("PHP and Node produce the same review metadata for the same capture", (t) => {
  const path = fileURLToPath(new URL("../app/transaction-review.php", import.meta.url));
  const result = spawnSync("php", ["-r", 'require $argv[1]; $data=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR); echo json_encode(with_transaction_reviews($data),JSON_THROW_ON_ERROR);', path], { encoding: "utf8", input: JSON.stringify(fixture()) });
  if (result.error?.code === "ENOENT") { t.skip("PHP runtime unavailable"); return; }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(withTransactionReviews(fixture()))));
});
