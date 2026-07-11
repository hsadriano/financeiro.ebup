import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, hasDatabaseConfig } from "./config.js";
import { JsonStorage } from "./storage.js";
import { MariaDbStorage } from "./mariadb-storage.js";
import { parseFinancialImage, parseFinancialMessage, summarizeTransaction } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
await loadEnv(root);

const publicDir = path.join(root, "public");
const uploadDir = path.join(root, "uploads");
const port = Number(process.env.PORT || 3020);
const host = process.env.HOST || "127.0.0.1";
const storage = await createStorage();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(response, buildState(await storage.read()));
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(request);
      await storage.addMessage({ role: "user", content: body.message });
      const parsed = await parseFinancialMessage(body.message);

      let assistantContent;
      if (parsed.intent === "transaction") {
        const saved = await storage.addTransaction({ ...parsed.transaction, status: "pending" });
        assistantContent = `${summarizeTransaction(saved)} Confira os dados e confirme para salvar nos relatorios.`;
      } else {
        assistantContent = parsed.answer;
      }

      await storage.addMessage({ role: "assistant", content: assistantContent });
      return sendJson(response, buildState(await storage.read()));
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/transactions/")) {
      const [, , , id, action] = url.pathname.split("/");
      if (!id || !["confirm", "dismiss", "update"].includes(action)) {
        return sendJson(response, { error: "Acao invalida" }, 400);
      }

      if (action === "update") {
        const body = await readJson(request);
        const changes = normalizeTransactionChanges(body);
        const updated = await storage.updateTransaction(id, changes);
        if (!updated) return sendJson(response, { error: "Lancamento nao encontrado" }, 404);
        return sendJson(response, buildState(await storage.read()));
      }

      const status = action === "confirm" ? "confirmed" : "dismissed";
      const updated = await storage.updateTransactionStatus(id, status);
      if (!updated) return sendJson(response, { error: "Lancamento nao encontrado" }, 404);

      const verb = action === "confirm" ? "confirmado" : "descartado";
      await storage.addMessage({ role: "assistant", content: `Lancamento ${verb}: ${updated.description}` });
      return sendJson(response, buildState(await storage.read()));
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      const file = await saveUpload(request);
      const document = await storage.addDocument({
        originalName: file.originalName,
        storedName: file.storedName,
        mimeType: file.mimeType,
        status: "ocr_pending"
      });

      let message =
        `Recebi o arquivo "${document.originalName}". `;
      const imageBuffer = await readFile(file.filePath);
      const parsed = await parseFinancialImage(imageBuffer, file.mimeType, file.originalName);
      if (parsed?.intent === "transaction") {
        const saved = await storage.addTransaction({ ...parsed.transaction, status: "pending" });
        await storage.updateDocumentStatus(document.id, "review_pending");
        message += `${summarizeTransaction(saved)} Confira os dados extraidos por OCR antes de confirmar.`;
      } else if (file.mimeType.startsWith("image/") && process.env.OPENAI_API_KEY) {
        await storage.updateDocumentStatus(document.id, "failed");
        message += "Tentei fazer OCR, mas nao consegui encontrar uma transacao financeira com seguranca.";
      } else if (file.mimeType.startsWith("image/")) {
        message += "Para fazer OCR automaticamente, configure OPENAI_API_KEY no .env.";
      } else {
        message += "Por enquanto o OCR automatico esta habilitado para imagens. PDF fica salvo para a proxima etapa.";
      }
      await storage.addMessage({ role: "assistant", content: message });
      return sendJson(response, buildState(await storage.read()));
    }

    if (request.method === "GET") {
      return serveStatic(response, url.pathname);
    }

    sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    sendJson(response, { error: "Erro interno", detail: error.message }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Finance Assistant MVP running at http://${host}:${port}`);
});

async function createStorage() {
  if (!hasDatabaseConfig()) {
    console.log("Database config not found; using local JSON storage.");
    return new JsonStorage(path.join(root, "data", "finance.json"));
  }

  const database = new MariaDbStorage({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS || ""
  });

  await database.init();
  console.log(`Using MariaDB database "${process.env.DB_NAME}" at ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}.`);
  return database;
}

function buildState(data) {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const confirmedTransactions = data.transactions.filter((item) => ["confirmed", "paid", "scheduled"].includes(item.status));
  const pendingTransactions = data.transactions.filter((item) => item.status === "pending");
  const monthTransactions = confirmedTransactions.filter((item) => item.transactionDate.startsWith(month));
  const income = sum(monthTransactions.filter((item) => item.kind === "income"));
  const expenses = sum(monthTransactions.filter((item) => item.kind === "expense"));
  const payable = data.transactions
    .filter((item) => item.status === "scheduled")
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const categories = groupByCategory(monthTransactions);

  return {
    messages: data.messages,
    transactions: confirmedTransactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    pendingTransactions: pendingTransactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    documents: data.documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    summary: {
      income,
      expenses,
      result: income - expenses,
      payableTotal: sum(payable),
      payableCount: payable.length,
      categories
    }
  };
}

function sum(items) {
  return Number(items.reduce((total, item) => total + Number(item.amount || 0), 0).toFixed(2));
}

function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.kind !== "expense") continue;
    groups.set(item.category, (groups.get(item.category) || 0) + Number(item.amount));
  }
  return [...groups.entries()]
    .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);
}

function normalizeTransactionChanges(body) {
  const amount = Number(String(body.amount || "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Valor invalido.");
  }

  const kind = body.kind === "income" ? "income" : "expense";
  return {
    kind,
    amount,
    description: String(body.description || "").trim().slice(0, 160) || "Lancamento sem descricao",
    merchant: String(body.merchant || "").trim() || null,
    paymentMethod: String(body.paymentMethod || "").trim() || null,
    transactionDate: normalizeDate(body.transactionDate),
    dueDate: body.dueDate ? normalizeDate(body.dueDate) : null,
    category: String(body.category || "").trim() || (kind === "income" ? "Renda" : "Outros")
  };
}

function normalizeDate(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error("Data invalida.");
  }
  return text;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function saveUpload(request) {
  const contentType = request.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(.+)$/)?.[1];
  if (!boundary) throw new Error("Upload sem boundary multipart.");

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const parts = buffer.toString("binary").split(`--${boundary}`);
  const filePart = parts.find((part) => part.includes("filename="));
  if (!filePart) throw new Error("Nenhum arquivo enviado.");

  const [rawHeaders, rawContent] = filePart.split("\r\n\r\n");
  const originalName = rawHeaders.match(/filename="([^"]+)"/)?.[1] || "arquivo";
  const mimeType = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
  const content = Buffer.from(rawContent.replace(/\r\n--$/, "").replace(/\r\n$/, ""), "binary");
  const extension = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`;

  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, storedName), content);

  return { originalName, storedName, mimeType, filePath: path.join(uploadDir, storedName) };
}

async function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return sendJson(response, { error: "Forbidden" }, 403);

  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, { error: "Not found" }, 404);
    throw error;
  }
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
