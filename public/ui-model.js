export function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function groupDrafts(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.recurrenceGroupId || item.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((group) => group.sort((a, b) => (a.dueDate || a.transactionDate).localeCompare(b.dueDate || b.transactionDate)));
}

export function captureDrafts(data, ids) {
  const selected = new Set(ids.map(String));
  return (data.pendingTransactions || []).filter((item) => selected.has(String(item.id)));
}

export function seriesTargets(items, transaction, scope) {
  if (scope === "one" || !transaction.recurrenceGroupId) return [transaction];
  return items.filter((item) => item.recurrenceGroupId === transaction.recurrenceGroupId &&
    (scope === "all" || (item.dueDate || item.transactionDate) >= (transaction.dueDate || transaction.transactionDate)));
}

export function moveTargets(items, ids) {
  const selectedIds = new Set(ids.map(String));
  const active = items.filter((item) => item.status !== "dismissed");
  const selected = active.filter((item) => selectedIds.has(String(item.id)));
  if (!selected.length || selected.length !== selectedIds.size) {
    throw Object.assign(new Error("Não encontrei todos os lançamentos selecionados no espaço atual."), { status: 404 });
  }
  const recurrenceIds = new Set(selected.map((item) => item.recurrenceGroupId).filter(Boolean).map(String));
  return active.filter((item) => selectedIds.has(String(item.id)) || recurrenceIds.has(String(item.recurrenceGroupId || "")));
}

export function filterLedger(items, filters, now = new Date()) {
  const normalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const month = filters.period === "previous-month"
    ? localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7)
    : localDate(now).slice(0, 7);
  return items.filter((item) => {
    if (filters.kind !== "all" && item.kind !== filters.kind) return false;
    if (filters.period !== "all" && !item.transactionDate.startsWith(month)) return false;
    if (filters.category && normalize(item.category) !== normalize(filters.category)) return false;
    if (filters.wallet && String(item.accountId) !== filters.wallet) return false;
    return !filters.search || normalize([item.description, item.category, item.accountName].join(" ")).includes(normalize(filters.search));
  }).sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
}

export function settledTotals(items, month) {
  return items.filter((item) => item.status !== "scheduled" && item.transactionDate.startsWith(month)).reduce((total, item) => {
    total[item.kind === "income" ? "income" : "expenses"] += Number(item.amount);
    total.result = total.income - total.expenses;
    return total;
  }, { income: 0, expenses: 0, result: 0 });
}
