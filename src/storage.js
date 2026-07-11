import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const initialData = {
  transactions: [],
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

  async addDocument(document) {
    const data = await this.read();
    const saved = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...document };
    data.documents.push(saved);
    await this.write(data);
    return saved;
  }
}
