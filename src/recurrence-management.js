import { createHash } from "node:crypto";

export function recurrenceToken(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function planRecurrenceChange(transactions, options = {}) {
  const { anchorId, scope = "next", action, day } = options || {};
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (!["one", "next", "all"].includes(scope) || !["cancel", "reschedule"].includes(action)) fail("Operação de recorrência inválida.");
  if (!["string", "number"].includes(typeof anchorId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(String(anchorId))) fail("Selecione uma parcela válida.");
  const anchor = transactions.find((item) => String(item.id) === String(anchorId) && item.status !== "dismissed");
  if (!anchor?.recurrenceGroupId) fail("A série recorrente não foi encontrada neste espaço.", 404);
  if (action === "reschedule" && (!["string", "number"].includes(typeof day) || !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 31)) fail("Informe um dia de vencimento entre 1 e 31.");
  const position = (item) => Number(item.recurrenceIndex) || 0;
  const anchorDate = anchor.dueDate || anchor.transactionDate;
  const selected = transactions.filter((item) => {
    if (item.recurrenceGroupId !== anchor.recurrenceGroupId || !item.dueDate || !["pending", "scheduled"].includes(item.status)) return false;
    if (scope === "one") return String(item.id) === String(anchor.id);
    if (scope === "all") return true;
    return position(item) && position(anchor) ? position(item) >= position(anchor) : (item.dueDate || item.transactionDate) >= anchorDate;
  }).sort((a, b) => (a.dueDate || a.transactionDate).localeCompare(b.dueDate || b.transactionDate));
  if (selected.length > 500) fail("A série inclui mais de 500 parcelas em aberto. Divida a alteração em grupos menores.");
  const byId = new Map(selected.map((item) => [String(item.id), item]));
  const changes = selected.map((item) => {
    if (action === "cancel") return { id: String(item.id), status: "dismissed" };
    const [year, month] = item.dueDate.split("-").map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) || year < 1000 || month < 1 || month > 12) fail("Uma parcela tem vencimento inválido. Corrija a data antes de alterar a série.");
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dueDate = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(Number(day), lastDay)).padStart(2, "0")}`;
    return { id: String(item.id), dueDate, transactionDate: dueDate };
  }).filter((change) => action === "cancel" || byId.get(change.id).dueDate !== change.dueDate || byId.get(change.id).transactionDate !== change.transactionDate);
  const items = changes.map((change) => {
    const item = byId.get(change.id);
    return { id: change.id, description: item.description || "Parcela", kind: item.kind || "expense", amount: Number(item.amount || 0), status: item.status, oldDate: item.dueDate, newDate: change.dueDate || null };
  });
  const preservedCount = transactions.filter((item) => item.recurrenceGroupId === anchor.recurrenceGroupId && ["paid", "confirmed"].includes(item.status)).length;
  return { recurrenceGroupId: anchor.recurrenceGroupId, action, changes, items, count: changes.length, preservedCount };
}
