import { createServer } from "node:http";
import crypto from "node:crypto";
import tls from "node:tls";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, hasDatabaseConfig } from "./config.js";
import { JsonStorage } from "./storage.js";
import { MariaDbStorage } from "./mariadb-storage.js";
import { parseFinancialImage, parseFinancialMessage, summarizeTransaction, summarizeTransactions } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
await loadEnv(root);

const publicDir = path.join(root, "public");
const uploadDir = path.join(root, "uploads");
const googleCredentialsDir = path.join(root, "app", "config", "keys");
const port = Number(process.env.PORT || 3020);
const host = process.env.HOST || "127.0.0.1";
const storage = await createStorage();
let googleAccessTokenCache = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/session") {
      const session = await currentSession(request);
      return sendJson(response, session ? await sessionPayload(session) : { user: null, controls: [] });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readJson(request);
      const user = await registerUser(body);
      const controlId = await createControl(user.id, "Meu controle financeiro");
      await createLoginSession(response, user.id, controlId, Boolean(body.remember ?? true));
      storage.setContext(user.id, controlId);
      await storage.addMessage({ role: "assistant", content: "Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload." });
      return sendJson(response, await sessionPayload({ userId: user.id, activeControlId: controlId }));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJson(request);
      const user = await authenticateUser(body);
      const controls = await listControls(user.id);
      const controlId = Number(controls[0]?.id || await createControl(user.id, "Meu controle financeiro"));
      await createLoginSession(response, user.id, controlId, Boolean(body.remember ?? true));
      return sendJson(response, await sessionPayload({ userId: user.id, activeControlId: controlId }));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      await logout(request, response);
      return sendJson(response, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/forgot") {
      const body = await readJson(request);
      await requestPasswordReset(body, request);
      return sendJson(response, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/reset") {
      const body = await readJson(request);
      await resetPassword(body);
      return sendJson(response, { ok: true });
    }

    if (["GET", "HEAD"].includes(request.method) && !url.pathname.startsWith("/api/")) {
      return serveStatic(response, url.pathname, request.method);
    }

    const session = await currentSession(request);
    if (!session) return sendJson(response, { error: "Nao autenticado" }, 401);
    if (!(await userCanAccessControl(session.userId, session.activeControlId))) {
      const controls = await listControls(session.userId);
      session.activeControlId = Number(controls[0]?.id || await createControl(session.userId, "Meu controle financeiro"));
      await setActiveControl(request, session.activeControlId);
    }
    storage.setContext(session.userId, session.activeControlId);

    if (request.method === "POST" && url.pathname === "/api/controls") {
      const body = await readJson(request);
      const controlId = await createControl(session.userId, String(body.name || "Novo controle financeiro").trim());
      await setActiveControl(request, controlId);
      storage.setContext(session.userId, controlId);
      await storage.addMessage({ role: "assistant", content: "Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload." });
      return sendJson(response, await sessionPayload({ userId: session.userId, activeControlId: controlId }));
    }

    if (request.method === "POST" && url.pathname === "/api/controls/select") {
      const body = await readJson(request);
      const controlId = Number(body.controlId);
      if (!controlId || !(await userCanAccessControl(session.userId, controlId))) return sendJson(response, { error: "Controle financeiro indisponivel" }, 403);
      await setActiveControl(request, controlId);
      return sendJson(response, await sessionPayload({ userId: session.userId, activeControlId: controlId }));
    }

    if (request.method === "POST" && url.pathname === "/api/controls/share") {
      const body = await readJson(request);
      await shareControl(session.userId, session.activeControlId, String(body.email || "").trim());
      return sendJson(response, await sessionPayload(session));
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(response, { ...buildState(await storage.read()), session: await sessionPayload(session) });
    }

    if (request.method === "GET" && /^\/api\/documents\/[^/]+\/view$/.test(url.pathname)) {
      const [, , , id] = url.pathname.split("/");
      return sendDocument(response, await documentFileFor(id), url.searchParams);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(request);
      await storage.addMessage({ role: "user", content: body.message });
      const parsed = await parseFinancialMessage(body.message);

      let assistantContent;
      if (parsed.intent === "transaction") {
        const transactions = parsed.transactions || [parsed.transaction];
        const saved = [];
        for (const transaction of transactions) {
          saved.push(await storage.addTransaction({ ...transaction, status: "pending" }));
        }
        assistantContent =
          saved.length > 1
            ? `${summarizeTransactions(saved)} Confira os dados e confirme para salvar nos relatorios.`
            : `${summarizeTransaction(saved[0])} Confira os dados e confirme para salvar nos relatorios.`;
      } else {
        assistantContent = answerAnalyticalQuestion(body.message, await storage.read()) || parsed.answer;
      }

      await storage.addMessage({ role: "assistant", content: assistantContent });
      return sendJson(response, buildState(await storage.read()));
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/transactions/")) {
      const [, , , id, action] = url.pathname.split("/");
      if (!id || !["confirm", "dismiss", "remove", "update"].includes(action)) {
        return sendJson(response, { error: "Acao invalida" }, 400);
      }

      if (action === "update") {
        const body = await readJson(request);
        const changes = normalizeTransactionChanges(body);
        const updated = await storage.updateTransaction(id, changes);
        if (!updated) return sendJson(response, { error: "Lancamento nao encontrado" }, 404);
        return sendJson(response, buildState(await storage.read()));
      }

      let status = action === "confirm" ? "confirmed" : "dismissed";
      let updated = await storage.updateTransactionStatus(id, status);
      if (!updated) return sendJson(response, { error: "Lancamento nao encontrado" }, 404);
      if (action === "confirm" && updated.kind === "expense" && updated.dueDate) {
        status = "scheduled";
        updated = await storage.updateTransactionStatus(id, status);
      }

      const verb = action === "confirm" ? "confirmado" : action === "remove" ? "removido" : "descartado";
      await storage.addMessage({ role: "assistant", content: `Lancamento ${verb}: ${updated.description}` });
      return sendJson(response, buildState(await storage.read()));
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      const file = await saveUpload(request, session.activeControlId);
      const document = await storage.addDocument({
        originalName: file.originalName,
        storedName: file.storedName,
        mimeType: file.mimeType,
        status: "ocr_pending"
      });

      let message =
        `Recebi o arquivo "${document.originalName}". `;
      const parsed = await parseFinancialImage(file.buffer, file.mimeType, file.originalName);
      if (parsed?.intent === "transaction") {
        const saved = await storage.addTransaction({ ...parsed.transaction, status: "pending" });
        const friendlyName = documentNameFromTransaction(saved.description, document.originalName);
        await storage.updateDocumentName(document.id, friendlyName);
        document.originalName = friendlyName;
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

    if (["GET", "HEAD"].includes(request.method) && !url.pathname.startsWith("/api/")) {
      return serveStatic(response, url.pathname, request.method);
    }

    sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    sendJson(response, { error: error.message || "Erro interno" }, error.status || 500);
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
  const expenseCategories = groupByCategory(monthTransactions, "expense");
  const incomeCategories = groupByCategory(monthTransactions, "income");
  const monthlySeries = buildMonthlySeries(confirmedTransactions, now);

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
      categories: expenseCategories,
      expenseCategories,
      incomeCategories,
      monthlySeries
    }
  };
}

function sum(items) {
  return Number(items.reduce((total, item) => total + Number(item.amount || 0), 0).toFixed(2));
}

function groupByCategory(items, kind = "expense") {
  const groups = new Map();
  for (const item of items) {
    if (item.kind !== kind) continue;
    groups.set(item.category, (groups.get(item.category) || 0) + Number(item.amount));
  }
  return [...groups.entries()]
    .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);
}

function buildMonthlySeries(transactions, now) {
  const months = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  for (let index = 0; index < 6; index += 1) {
    const key = cursor.toISOString().slice(0, 7);
    months.push({
      key,
      label: new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" }).format(cursor),
      shortLabel: new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" }).format(cursor).replace(".", ""),
      income: 0,
      expenses: 0,
      result: 0
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const byKey = new Map(months.map((item) => [item.key, item]));
  for (const transaction of transactions) {
    const bucket = byKey.get(String(transaction.transactionDate).slice(0, 7));
    if (!bucket) continue;
    if (transaction.kind === "income") bucket.income += Number(transaction.amount || 0);
    if (transaction.kind === "expense") bucket.expenses += Number(transaction.amount || 0);
  }

  return months.map((item) => ({
    ...item,
    income: Number(item.income.toFixed(2)),
    expenses: Number(item.expenses.toFixed(2)),
    result: Number((item.income - item.expenses).toFixed(2))
  }));
}

function answerAnalyticalQuestion(message, data) {
  const text = normalizeText(message);
  const isPayableQuestion =
    /\b(contas?|boletos?|faturas?|vencimentos?)\b/.test(text) &&
    /\b(pagar|vencer|vence|proxim[ao]s?)\b/.test(text);
  if (!isPayableQuestion) return null;

  const { start, end, label } = resolveQuestionPeriod(text);
  const items = data.transactions
    .filter((item) => item.kind === "expense" && item.status === "scheduled")
    .filter((item) => {
      const date = item.dueDate || item.transactionDate;
      return date >= start && date <= end;
    })
    .sort((a, b) => String(a.dueDate || a.transactionDate).localeCompare(String(b.dueDate || b.transactionDate)));

  if (!items.length) {
    return `Voce nao tem contas agendadas para pagar ${label}.`;
  }

  const total = sum(items);
  const lines = items
    .slice(0, 8)
    .map((item) => `${formatShortDate(item.dueDate || item.transactionDate)}: ${item.description} (${formatMoney(item.amount)})`);
  const extra = items.length > 8 ? ` Tenho mais ${items.length - 8} alem dessas.` : "";
  return `Voce tem ${items.length} conta${items.length > 1 ? "s" : ""} para pagar ${label}, totalizando ${formatMoney(total)}. ${lines.join(" ")}${extra}`;
}

function resolveQuestionPeriod(text) {
  const today = new Date();
  const start = toIsoDate(today);
  const end = new Date(today);

  if (text.includes("hoje")) {
    return { start, end: start, label: "hoje" };
  }
  if (text.includes("amanha")) {
    end.setDate(today.getDate() + 1);
    const iso = toIsoDate(end);
    return { start: iso, end: iso, label: "amanha" };
  }
  if (text.includes("semana")) {
    end.setDate(today.getDate() + 6);
    return { start, end: toIsoDate(end), label: "esta semana" };
  }

  end.setDate(today.getDate() + 30);
  return { start, end: toIsoDate(end), label: "nos proximos 30 dias" };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" }).format(new Date(`${value}T00:00:00Z`));
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function documentFileFor(id) {
  const data = await storage.read();
  const document = data.documents.find((item) => String(item.id) === String(id));
  if (!document) {
    const error = new Error("Arquivo nao encontrado.");
    error.status = 404;
    throw error;
  }

  const objectName = documentObjectName(document.storedName);
  const filePath = path.resolve(uploadDir, objectName);
  const uploadRoot = path.resolve(uploadDir);
  if (!filePath.startsWith(`${uploadRoot}${path.sep}`)) {
    const error = new Error("Arquivo invalido.");
    error.status = 400;
    throw error;
  }

  let content;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT" && String(document.storedName || "").startsWith("gs://")) {
      content = await downloadFromGoogleCloudStorage(document.storedName);
    } else if (error.code === "ENOENT") {
      const notFound = new Error("Arquivo indisponivel.");
      notFound.status = 404;
      throw notFound;
    }
    throw error;
  }
  return { document, content };
}

async function downloadFromGoogleCloudStorage(storedName) {
  const { bucket, objectName } = parseGoogleStorageUri(storedName);
  const credentials = await loadGoogleCredentials();
  if (!credentials) {
    const error = new Error("Arquivo indisponivel.");
    error.status = 404;
    throw error;
  }

  const token = await getGoogleAccessToken(credentials);
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`);
  url.searchParams.set("alt", "media");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const error = new Error("Arquivo indisponivel.");
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseGoogleStorageUri(storedName) {
  const withoutScheme = String(storedName || "").slice("gs://".length);
  const [bucket, ...objectParts] = withoutScheme.split("/");
  return { bucket, objectName: objectParts.join("/") };
}

function documentObjectName(storedName) {
  const value = String(storedName || "");
  if (value.startsWith("gs://")) {
    const withoutScheme = value.slice("gs://".length);
    return withoutScheme.split("/").slice(1).join("/");
  }
  return value;
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

async function saveUpload(request, controlId) {
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
  const objectName = `controls/${controlId}/documents/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${crypto.randomUUID()}${extension}`;
  const localPath = path.join(uploadDir, objectName);

  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, content);

  const storedName = await uploadToGoogleCloudStorage(content, objectName, mimeType);
  return { originalName, storedName, mimeType, filePath: localPath, buffer: content };
}

async function uploadToGoogleCloudStorage(content, objectName, mimeType) {
  const bucket = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucket) return objectName;

  const credentials = await loadGoogleCredentials();
  if (!credentials) {
    throw new Error("GOOGLE_CLOUD_BUCKET_NAME esta configurado, mas nao encontrei credenciais em GOOGLE_CLOUD_CREDENTIALS_FILE ou app/config/keys/*.json.");
  }

  const token = await getGoogleAccessToken(credentials);
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", objectName);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mimeType,
      "Content-Length": String(content.length)
    },
    body: content
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Falha ao enviar arquivo para o Google Cloud Storage (${response.status}). ${detail}`.trim());
  }

  return `gs://${bucket}/${objectName}`;
}

async function loadGoogleCredentials() {
  const explicitPath = String(process.env.GOOGLE_CLOUD_CREDENTIALS_FILE || "").trim();
  if (explicitPath) {
    return JSON.parse(await readFile(path.resolve(root, explicitPath), "utf8"));
  }

  try {
    const files = await readdir(googleCredentialsDir);
    const jsonFile = files.find((file) => file.endsWith(".json"));
    if (!jsonFile) return null;
    return JSON.parse(await readFile(path.join(googleCredentialsDir, jsonFile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function getGoogleAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  if (googleAccessTokenCache && googleAccessTokenCache.expiresAt > now + 60) {
    return googleAccessTokenCache.token;
  }

  const assertion = signGoogleJwt(credentials, now);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Falha ao autenticar no Google Cloud (${response.status}). ${detail}`.trim());
  }

  const payload = await response.json();
  googleAccessTokenCache = {
    token: payload.access_token,
    expiresAt: now + Number(payload.expires_in || 3600)
  };
  return googleAccessTokenCache.token;
}

function signGoogleJwt(credentials, now) {
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function serveStatic(response, pathname, method = "GET") {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return sendJson(response, { error: "Forbidden" }, 403);

  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    response.end(method === "HEAD" ? undefined : content);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, { error: "Not found" }, 404);
    throw error;
  }
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendDocument(response, { document, content }, searchParams = new URLSearchParams()) {
  const extension = path.extname(document.originalName || document.storedName || "");
  const contentType = document.mimeType || mimeTypes[extension] || "application/octet-stream";
  const filename = String(document.originalName || "arquivo").replace(/["\r\n]/g, "");
  if (contentType.startsWith("image/") && searchParams.get("raw") !== "1") {
    return sendImageViewer(response, document);
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "private, max-age=120"
  });
  response.end(content);
}

function sendImageViewer(response, document) {
  const filename = escapeHtml(String(document.originalName || "Imagem"));
  const imageUrl = `/api/documents/${encodeURIComponent(document.id)}/view?raw=1`;
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, max-age=120"
  });
  response.end(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${filename}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; color: #fff; background: #101512; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .viewer { display: grid; min-height: 100dvh; padding: calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom)); place-items: center; }
    button { position: fixed; top: calc(10px + env(safe-area-inset-top)); right: 10px; z-index: 2; width: 42px; height: 42px; border: 1px solid rgba(255,255,255,.34); border-radius: 999px; color: #fff; background: rgba(16,21,18,.72); font: inherit; font-size: 1.35rem; font-weight: 800; line-height: 1; backdrop-filter: blur(8px); }
    img { max-width: 100%; max-height: calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); object-fit: contain; border-radius: 8px; background: #fff; }
  </style>
</head>
<body>
  <div class="viewer">
    <button type="button" aria-label="Fechar" title="Fechar" onclick="window.close(); if (!window.closed) history.back();">×</button>
    <img src="${imageUrl}" alt="${filename}" />
  </div>
</body>
</html>`);
}

function documentNameFromTransaction(description, originalName) {
  const extension = path.extname(originalName || "").replace(/[^a-zA-Z0-9.]/g, "") || ".jpg";
  const base = String(description || "Comprovante")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80) || "Comprovante";
  return `${base}${extension.toLowerCase()}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [key, ...value] = item.split("=");
        return [key, decodeURIComponent(value.join("="))];
      })
  );
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionCookie(token, expires) {
  const parts = [
    `finance_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

async function currentSession(request) {
  const token = parseCookies(request).finance_session;
  if (!token || !storage.pool) return null;
  const [rows] = await storage.pool.execute(
    `SELECT user_id AS userId, active_control_id AS activeControlId
     FROM user_sessions
     WHERE token_hash = ? AND expires_at > NOW()
     LIMIT 1`,
    [sessionTokenHash(token)]
  );
  return rows[0] || null;
}

async function createLoginSession(response, userId, controlId, remember) {
  if (!storage.pool) throw new Error("Autenticacao requer MariaDB configurado.");
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMs = remember ? 45 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  const expires = new Date(Date.now() + ttlMs);
  await storage.pool.execute(
    `INSERT INTO user_sessions (token_hash, user_id, active_control_id, expires_at)
     VALUES (?, ?, ?, ?)`,
    [sessionTokenHash(token), userId, controlId, toMysqlDateTime(expires)]
  );
  response.setHeader("Set-Cookie", sessionCookie(token, expires));
}

async function logout(request, response) {
  const token = parseCookies(request).finance_session;
  if (token && storage.pool) {
    await storage.pool.execute(`DELETE FROM user_sessions WHERE token_hash = ?`, [sessionTokenHash(token)]);
  }
  response.setHeader("Set-Cookie", sessionCookie("", new Date(0)));
}

async function hashPassword(password) {
  const iterations = 210000;
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256:${iterations}:${salt}:${hash}`;
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split(":");
  const [scheme] = parts;
  if (scheme === "pbkdf2_sha256") {
    const [, iterations, salt, expected] = parts;
    if (!iterations || !salt || !expected) return false;
    const actual = await pbkdf2(password, salt, Number(iterations));
    return safeCompareHex(actual, expected);
  }
  if (scheme === "scrypt") {
    const [, salt, expected] = parts;
    if (!salt || !expected) return false;
    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key.toString("hex"))));
    });
    return safeCompareHex(actual, expected);
  }
  return false;
}

function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, "sha256", (error, key) =>
      error ? reject(error) : resolve(key.toString("hex"))
    );
  });
}

function safeCompareHex(actual, expected) {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function registerUser(body) {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6) {
    const error = new Error("Informe nome, e-mail valido e senha com pelo menos 6 caracteres.");
    error.status = 400;
    throw error;
  }

  const [existing] = await storage.pool.execute(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
  if (existing.length) {
    const error = new Error("Este e-mail ja esta cadastrado.");
    error.status = 409;
    throw error;
  }

  const [result] = await storage.pool.execute(
    `INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`,
    [name, email, await hashPassword(password)]
  );
  return { id: result.insertId, name, email };
}

async function authenticateUser(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const [rows] = await storage.pool.execute(
    `SELECT id, name, email, password_hash AS passwordHash FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    const error = new Error("E-mail ou senha invalidos.");
    error.status = 401;
    throw error;
  }
  return user;
}

async function requestPasswordReset(body, request) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;

  const [rows] = await storage.pool.execute(
    `SELECT id, name, email FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
  const user = rows[0];
  if (!user) return;

  await storage.pool.execute(
    `DELETE FROM password_reset_tokens WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at <= NOW())`,
    [user.id]
  );

  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await storage.pool.execute(
    `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
    [sessionTokenHash(token), user.id, toMysqlDateTime(expires)]
  );

  const resetUrl = `${requestOrigin(request)}/?reset=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Redefinicao de senha do Finup",
    text: [
      `Ola, ${user.name}.`,
      "",
      "Recebemos uma solicitacao para redefinir sua senha no Finup.",
      `Use este link para criar uma nova senha: ${resetUrl}`,
      "",
      "Este link expira em 1 hora. Se voce nao solicitou, ignore este e-mail."
    ].join("\n")
  });
}

async function resetPassword(body) {
  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  if (!token || password.length < 6) {
    const error = new Error("Link invalido ou senha muito curta.");
    error.status = 400;
    throw error;
  }

  const [rows] = await storage.pool.execute(
    `SELECT user_id AS userId
     FROM password_reset_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [sessionTokenHash(token)]
  );
  const reset = rows[0];
  if (!reset) {
    const error = new Error("Link invalido ou expirado.");
    error.status = 400;
    throw error;
  }

  await storage.pool.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [await hashPassword(password), reset.userId]);
  await storage.pool.execute(`UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = ?`, [sessionTokenHash(token)]);
  await storage.pool.execute(`DELETE FROM user_sessions WHERE user_id = ?`, [reset.userId]);
}

function requestOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || (request.headers.host?.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${request.headers.host}`;
}

async function sendMail({ to, subject, text }) {
  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT || 465);
  const username = process.env.MAIL_USERNAME;
  const password = process.env.MAIL_PASSWORD;
  const fromEmail = process.env.MAIL_FROM_EMAIL || username;
  const fromName = process.env.MAIL_FROM_NAME || "Finup";
  if (!host || !username || !password || !fromEmail) {
    throw new Error("Configuracao de e-mail incompleta.");
  }

  const socket = tls.connect({ host, port, servername: host });
  socket.setEncoding("utf8");
  let buffer = "";

  const readResponse = () =>
    new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/).filter(Boolean);
        const last = lines.at(-1);
        if (last && /^\d{3} /.test(last)) {
          socket.off("data", onData);
          const response = buffer;
          buffer = "";
          const code = Number(last.slice(0, 3));
          if (code >= 400) reject(new Error(`SMTP ${response.trim()}`));
          else resolve(response);
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });

  const command = async (line) => {
    socket.write(`${line}\r\n`);
    return readResponse();
  };

  await readResponse();
  await command(`EHLO ${host}`);
  await command("AUTH LOGIN");
  await command(Buffer.from(username).toString("base64"));
  await command(Buffer.from(password).toString("base64"));
  await command(`MAIL FROM:<${fromEmail}>`);
  await command(`RCPT TO:<${to}>`);
  await command("DATA");
  socket.write(buildEmailMessage({ fromEmail, fromName, to, subject, text }));
  await readResponse();
  await command("QUIT").catch(() => {});
  socket.end();
}

function buildEmailMessage({ fromEmail, fromName, to, subject, text }) {
  const headers = [
    `From: ${encodeMailName(fromName)} <${fromEmail}>`,
    `To: <${to}>`,
    `Subject: ${encodeMailName(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  const escapedText = text.replaceAll("\n.", "\n..");
  return `${headers.join("\r\n")}\r\n\r\n${escapedText}\r\n.\r\n`;
}

function encodeMailName(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), "utf8").toString("base64")}?=`;
}

async function createControl(userId, name) {
  const controlName = String(name || "Novo controle financeiro").trim().slice(0, 160) || "Novo controle financeiro";
  const [result] = await storage.pool.execute(
    `INSERT INTO financial_controls (name, owner_user_id) VALUES (?, ?)`,
    [controlName, userId]
  );
  await storage.pool.execute(
    `INSERT INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)`,
    [result.insertId, userId, "owner"]
  );
  return result.insertId;
}

async function listControls(userId) {
  const [rows] = await storage.pool.execute(
    `SELECT CAST(c.id AS CHAR) AS id, c.name, m.role
     FROM financial_controls c
     INNER JOIN control_members m ON m.control_id = c.id
     WHERE m.user_id = ?
     ORDER BY c.name ASC`,
    [userId]
  );
  return rows;
}

async function userCanAccessControl(userId, controlId) {
  const [rows] = await storage.pool.execute(
    `SELECT 1 FROM control_members WHERE user_id = ? AND control_id = ? LIMIT 1`,
    [userId, controlId]
  );
  return Boolean(rows.length);
}

async function setActiveControl(request, controlId) {
  const token = parseCookies(request).finance_session;
  if (!token) return;
  await storage.pool.execute(
    `UPDATE user_sessions SET active_control_id = ? WHERE token_hash = ?`,
    [controlId, sessionTokenHash(token)]
  );
}

async function shareControl(ownerUserId, controlId, email) {
  if (!(await userCanAccessControl(ownerUserId, controlId))) {
    const error = new Error("Sem acesso ao controle financeiro.");
    error.status = 403;
    throw error;
  }
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const [rows] = await storage.pool.execute(`SELECT id FROM users WHERE email = ? LIMIT 1`, [normalizedEmail]);
  const user = rows[0];
  if (!user) {
    const error = new Error("Usuario nao encontrado. Ele precisa criar uma conta primeiro.");
    error.status = 404;
    throw error;
  }
  await storage.pool.execute(
    `INSERT IGNORE INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)`,
    [controlId, user.id, "editor"]
  );
}

async function sessionPayload(session) {
  const [rows] = await storage.pool.execute(
    `SELECT CAST(id AS CHAR) AS id, name, email FROM users WHERE id = ? LIMIT 1`,
    [session.userId]
  );
  return {
    user: rows[0] || null,
    controls: await listControls(session.userId),
    activeControlId: session.activeControlId ? String(session.activeControlId) : null
  };
}

function toMysqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
