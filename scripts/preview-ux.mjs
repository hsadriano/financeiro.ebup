import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { monthlyOccurrences } from "../src/transaction-input.js";
import { localDate } from "../public/ui-model.js";

// Isolated UI fixture: never loads .env, connects to a database or calls an AI provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const today = localDate();
const createdAt = new Date().toISOString();
const session = { user: { id: "demo", name: "Pessoa de teste", email: "demo@example.test" }, activeControlId: "home", controls: [{ id: "home", name: "Casa" }, { id: "work", name: "Trabalho" }] };
const transactions = [
  { id: "bread", kind: "expense", status: "confirmed", description: "Pão no mercadinho", amount: 15, category: "Mercado", transactionDate: today, createdAt },
  { id: "salary", kind: "income", status: "paid", description: "Salário", amount: 5000, category: "Renda", transactionDate: today, createdAt },
  { id: "internet", kind: "expense", status: "scheduled", description: "Internet", amount: 120, category: "Moradia", transactionDate: today, dueDate: today, createdAt },
  { id: "old", kind: "expense", status: "pending", description: "Farmácia (rascunho anterior)", amount: 49.9, category: "Saúde", transactionDate: today, createdAt }
];
const messages = [{ id: "welcome", role: "assistant", content: "Olá! O que você quer registrar ou consultar hoje?", createdAt }];
const wallets = [{ id: "cash", name: "Dinheiro", type: "cash", balance: 120, openingBalance: 120 }, { id: "bank", name: "Conta principal", type: "checking", balance: 3000, openingBalance: 3000 }];
let loggedIn = true;
const receipts = new Map();
let dropFirstCapture = process.env.PREVIEW_DROP_ONCE === "1";
function state(capture) {
  const start = new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1);
  const monthlySeries = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    return { key: localDate(date).slice(0, 7), shortLabel: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(date) };
  });
  return { session, transactions: transactions.filter((item) => !["dismissed", "pending"].includes(item.status)), pendingTransactions: transactions.filter((item) => item.status === "pending"), documents: [], messages, wallets, summary: { monthlySeries }, ...(capture ? { capture } : {}) };
}
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let receiptKey;
  let fingerprint;
  const json = (data, code = 200) => {
    if (receiptKey && code === 200 && data.capture && !data.capture.replayed) {
      data.capture = { ...data.capture, requestId: req.headers["idempotency-key"], messageId: url.pathname === "/api/transactions" ? null : data.messages.at(-1)?.id };
      receipts.set(receiptKey, { fingerprint, capture: structuredClone(data.capture) });
      if (dropFirstCapture) {
        dropFirstCapture = false;
        res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Resposta perdida na simulação de conexão." }));
        return;
      }
    }
    return res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  };
  try {
    if (!url.pathname.startsWith("/api/")) {
      const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(root + "/")) return res.writeHead(404).end();
      return res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(await readFile(file));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length && req.headers["content-type"]?.includes("application/json") ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.headers["idempotency-key"] && ["/api/transactions", "/api/chat"].includes(url.pathname)) {
      receiptKey = [req.headers["x-finup-user-id"], req.headers["x-finup-control-id"], req.headers["idempotency-key"]].join(":");
      fingerprint = crypto.createHash("sha256").update(url.pathname + JSON.stringify(body)).digest("hex");
      const previous = receipts.get(receiptKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return json({ error: "Este identificador pertence a outro envio." }, 409);
        return json(state({ ...previous.capture, replayed: true }));
      }
    }
    if (url.pathname === "/api/session") return json(loggedIn ? session : { user: null });
    if (url.pathname.startsWith("/api/auth/")) { loggedIn = !url.pathname.endsWith("/logout"); return json(session); }
    if (url.pathname === "/api/state") return json(state());
    if (url.pathname === "/api/controls/select") { session.activeControlId = body.controlId; return json(session); }
    if (url.pathname === "/api/transactions" || url.pathname === "/api/chat") {
      if (url.pathname.endsWith("/chat") && !/\d/.test(body.message)) {
        messages.push({ id: crypto.randomUUID(), role: "user", content: body.message, createdAt }, { id: crypto.randomUUID(), role: "assistant", content: "Você tem uma conta de internet de R$ 120,00 para hoje.", createdAt });
        return json(state({ transactionIds: [] }));
      }
      const values = url.pathname.endsWith("/chat") ? { amount: "15", description: "Pão no mercadinho", transactionDate: today, category: "Mercado" } : body;
      const items = monthlyOccurrences(values, crypto.randomUUID()).map((item) => ({ ...item, id: crypto.randomUUID(), createdAt, accountName: wallets.find((wallet) => wallet.id === item.accountId)?.name }));
      transactions.unshift(...items);
      messages.push({ id: crypto.randomUUID(), role: "assistant", content: "Preparei seu lançamento. Confira antes de salvar.", createdAt });
      return json(state({ transactionIds: items.map((item) => item.id) }));
    }
    if (url.pathname === "/api/transactions/bulk-update") {
      transactions.filter((item) => body.ids.includes(item.id)).forEach((item) => {
        if (body.amount) item.amount = Number(body.amount.replace(",", "."));
        if (body.accountId !== undefined) { item.accountId = body.accountId; item.accountName = wallets.find((wallet) => wallet.id === body.accountId)?.name; }
      });
      return json(state());
    }
    const match = url.pathname.match(/^\/api\/transactions\/([^/]+)\/([^/]+)$/);
    if (match) {
      const item = transactions.find((entry) => entry.id === match[1]);
      if (!item) return json({ error: "Não encontrado" }, 404);
      const action = match[2];
      if (action === "update") Object.assign(item, body, { amount: Number(String(body.amount).replace(",", ".")), status: item.status === "pending" ? "pending" : body.paymentState === "scheduled" ? "scheduled" : "confirmed" });
      if (action === "confirm") item.status = item.dueDate ? "scheduled" : "confirmed";
      if (action === "remove" || action === "dismiss") item.status = "dismissed";
      if (action === "restore") item.status = body.status;
      if (action === "paid") { item.status = "paid"; item.transactionDate = body.transactionDate; }
      return json(state());
    }
    return json({ error: "Operação indisponível nesta prévia de dados fictícios." }, 400);
  } catch (error) { return json({ error: error.message }, 500); }
});
server.listen(Number(process.env.PORT || 3021), "127.0.0.1", () => console.log("Prévia UX com dados fictícios: http://127.0.0.1:" + server.address().port));
