import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { confirmationIds, unreviewedDuplicateIds } from "./transaction-review.js";
import { planRecurrenceChange, recurrenceToken } from "./recurrence-management.js";

const initialData = {
  transactions: [],
  wallets: [],
  documents: [],
  messages: [
    {
      id: "welcome",
      role: "assistant",
      content:
        "Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload.",
      createdAt: new Date().toISOString()
    }
  ]
};

export class JsonStorage {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write(initialData);
      return structuredClone(initialData);
    }
  }

  async write(data) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
  }

  async addMessage(message) {
    const data = await this.read();
    data.messages.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...message });
    await this.write(data);
    return data.messages.at(-1);
  }

  async addTransaction(transaction) {
    const data = await this.read();
    const saved = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...transaction };
    data.transactions.push(saved);
    await this.write(data);
    return saved;
  }

  async updateTransactionStatus(id, status) {
    const data = await this.read();
    const transaction = data.transactions.find((item) => item.id === id);
    if (!transaction) return null;
    transaction.status = status;
    await this.write(data);
    return transaction;
  }

  async updateTransaction(id, changes) {
    const data = await this.read();
    const transaction = data.transactions.find((item) => item.id === id);
    if (!transaction) return null;
    Object.assign(transaction, changes);
    await this.write(data);
    return transaction;
  }

  async bulkUpdateTransactions({ ids = [], recurrenceGroupId = null, accountId, amount }) {
    const data = await this.read();
    const selected = new Set(ids.map(String));
    const wallet = accountId === undefined || accountId === null
      ? null
      : data.wallets.find((item) => String(item.id) === String(accountId));
    const targets = data.transactions.filter((item) => item.status !== "dismissed" && (
      recurrenceGroupId
        ? item.recurrenceGroupId === recurrenceGroupId
        : selected.has(String(item.id))
    ));

    for (const transaction of targets) {
      if (accountId !== undefined) {
        transaction.accountId = accountId;
        transaction.accountName = wallet?.name || null;
      }
      if (amount !== undefined) transaction.amount = amount;
    }
    if (targets.length) await this.write(data);
    return targets.length;
  }

  async addDocument(document) {
    const data = await this.read();
    const saved = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...document };
    data.documents.push(saved);
    await this.write(data);
    return saved;
  }

  async updateDocumentStatus(id, status) {
    const data = await this.read();
    const document = data.documents.find((item) => item.id === id);
    if (!document) return null;
    document.status = status;
    await this.write(data);
    return document;
  }

  async linkTransactionDocument(transactionId, documentId) {
    const data = await this.read();
    const transaction = data.transactions.find((item) => String(item.id) === String(transactionId));
    if (!transaction || !data.documents.some((item) => String(item.id) === String(documentId))) return;
    transaction.documentIds = [...new Set([...(transaction.documentIds || []), String(documentId)])];
    await this.write(data);
  }

  async manageRecurrence(options, apply = false) {
    const data = await this.read();
    const plan = planRecurrenceChange(data.transactions, options);
    const token = recurrenceToken(plan);
    if (!apply) return { ...plan, token };
    if (options.token !== token) throw Object.assign(new Error("A série mudou desde a prévia. Confira novamente antes de aplicar."), { status: 409 });
    if (plan.action === "cancel" && options.confirmCancellation !== true) throw Object.assign(new Error("Confirme o cancelamento antes de aplicar."), { status: 400 });
    if (!plan.count) throw Object.assign(new Error("Não há parcelas em aberto para alterar nesta seleção."), { status: 409 });
    for (const change of plan.changes) Object.assign(data.transactions.find((item) => String(item.id) === change.id), change);
    await this.write(data);
    return { action: plan.action, changedCount: plan.count };
  }

  async confirmTransactions(inputIds, reviewedIds = []) {
    const ids = confirmationIds(inputIds);
    const data = await this.read();
    const selected = new Set(ids);
    const rows = data.transactions.filter((item) => selected.has(String(item.id)) && item.status !== "dismissed");
    if (rows.length !== ids.length) throw Object.assign(new Error("Um ou mais lançamentos não foram encontrados neste espaço."), { status: 404 });
    const pending = rows.filter((item) => item.status === "pending");
    if (unreviewedDuplicateIds(data, pending.map((item) => item.id), Array.isArray(reviewedIds) ? reviewedIds : []).length) return { confirmedCount: 0, reviewRequired: true };
    for (const item of pending) item.status = item.dueDate ? "scheduled" : "confirmed";
    if (pending.length) await this.write(data);
    return { confirmedCount: pending.length, reviewRequired: false };
  }

  async updateDocumentName(id, originalName) {
    const data = await this.read();
    const document = data.documents.find((item) => item.id === id);
    if (!document) return null;
    document.originalName = originalName;
    await this.write(data);
    return document;
  }
}
