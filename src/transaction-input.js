export function validDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Informe uma data válida.");
  const date = new Date(`${text}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error("Informe uma data válida.");
  return text;
}

export function normalizeTransactionInput(body) {
  const text = String(body.amount ?? "").trim();
  const amount = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) throw new Error("Informe um valor válido.");
  const kind = body.kind === "income" ? "income" : "expense";
  return {
    kind, amount,
    description: String(body.description || "").trim().slice(0, 160) || (kind === "income" ? "Receita" : "Despesa"),
    category: String(body.category || "").trim().slice(0, 100) || (kind === "income" ? "Renda" : "Outros"),
    merchant: String(body.merchant || "").trim() || null,
    paymentMethod: String(body.paymentMethod || "").trim() || null,
    accountId: String(body.accountId || "").trim() || null,
    transactionDate: validDate(body.transactionDate),
    dueDate: body.dueDate ? validDate(body.dueDate) : null
  };
}

export function monthlyOccurrences(body, groupId) {
  const transaction = normalizeTransactionInput(body);
  const count = Number(body.repeatCount ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error("Escolha entre 1 e 60 meses.");
  const addMonths = (value, index) => {
    const [year, month, day] = value.split("-").map(Number);
    const target = new Date(Date.UTC(year, month - 1 + index, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
  };
  return Array.from({ length: count }, (_, index) => ({
    ...transaction,
    transactionDate: addMonths(transaction.transactionDate, index),
    dueDate: transaction.dueDate ? addMonths(transaction.dueDate, index) : index > 0 ? addMonths(transaction.transactionDate, index) : null,
    status: "pending", source: "manual", rawText: "", confidence: 1,
    recurrenceGroupId: count > 1 ? groupId : null,
    recurrenceIndex: count > 1 ? index + 1 : null,
    recurrenceTotal: count > 1 ? count : null
  }));
}
