import test from "node:test";
import assert from "node:assert/strict";
import { hasPdfSignature, parseFinancialDocument } from "../src/parser.js";

const pdfSample = Buffer.from("%PDF-1.7\nmock financial document");

test("parses a PDF through Responses API and returns a reviewable transaction", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_OCR_MODEL;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_OCR_MODEL = "gpt-4.1-nano";
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              intent: "transaction",
              transaction: {
                kind: "expense",
                financialStatus: "scheduled",
                amount: 139.9,
                description: "Conta de internet",
                merchant: "Provedor",
                paymentMethod: "Boleto",
                transactionDate: "2026-11-25",
                dueDate: "2026-11-25",
                category: "Moradia",
                confidence: 0.95
              }
            })
          }]
        }]
      })
    };
  };

  try {
    const parsed = await parseFinancialDocument(pdfSample, "application/pdf", "internet.pdf", new Date("2026-11-18T12:00:00Z"));
    assert.equal(requestUrl, "https://api.openai.com/v1/responses");
    assert.equal(requestBody.store, false);
    assert.deepEqual(requestBody.text.format, { type: "json_object" });
    const file = requestBody.input[1].content.find((part) => part.type === "input_file");
    assert.equal(file.filename, "internet.pdf");
    assert.equal(file.file_data, `data:application/pdf;base64,${pdfSample.toString("base64")}`);
    assert.equal(file.detail, "high");
    assert.equal(parsed.intent, "transaction");
    assert.equal(parsed.transaction.status, "scheduled");
    assert.equal(parsed.transaction.source, "upload");
    assert.equal(parsed.transaction.dueDate, "2026-11-25");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_OCR_MODEL;
    else process.env.OPENAI_OCR_MODEL = previousModel;
  }
});

test("keeps ambiguous paid status out of the transaction draft", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            intent: "transaction",
            transaction: {
              kind: "expense",
              financialStatus: "unclear",
              amount: 120,
              transactionDate: "2026-11-18",
              dueDate: null,
              confidence: 0.95
            }
          })
        }]
      }]
    })
  });

  try {
    const parsed = await parseFinancialDocument(pdfSample, "application/pdf", "fatura.pdf", new Date("2026-11-18T12:00:00Z"));
    assert.equal(parsed.intent, "question");
    assert.match(parsed.answer, /pago ou a pagar/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("does not send invalid PDFs or unsupported documents to the model", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => { throw new Error("Unexpected external call"); };

  try {
    assert.equal(hasPdfSignature(Buffer.from("not a PDF")), false);
    assert.equal(await parseFinancialDocument(Buffer.from("not a PDF"), "application/pdf", "broken.pdf"), null);
    assert.equal(await parseFinancialDocument(pdfSample, "text/plain", "notes.txt"), null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
