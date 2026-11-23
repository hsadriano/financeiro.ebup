const activeStatuses = new Set(["pending", "confirmed", "paid", "scheduled"]);
const ignoredWords = new Set(["a", "o", "as", "os", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas", "por", "para", "com", "um", "uma", "r", "rs", "reais", "compra", "compras", "pagamento", "recebimento", "despesa", "receita", "boleto", "recibo", "pix", "cartao"]);

export function reviewText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\s*\(\d+\s*\/\s*\d+\)\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function textTokens(value) {
  return new Set(reviewText(value).split(/\s+/).filter((word) => word.length >= 3 && !ignoredWords.has(word) && !/^\d+$/.test(word)));
}

function similarDescription(left, right) {
  const a = textTokens(left);
  const b = textTokens(right);
  if (!a.size || !b.size) return false;
  const common = [...a].filter((word) => b.has(word));
  if (common.length === a.size && common.length === b.size) return true;
  return common.length >= 2 && common.length / Math.min(a.size, b.size) >= 0.75;
}

function financialDates(item) {
  return [...new Set([item.transactionDate, item.dueDate].filter((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)))];
}

function financialKeys(item) {
  const cents = Math.round(Number(item.amount) * 100);
  return Number.isFinite(cents) && cents > 0 ? financialDates(item).map((day) => `${item.kind}:${cents}:${day}`) : [];
}

function appendIndex(index, key, item) {
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(item);
}

export function publicDocument(document) {
  return { id: String(document.id), originalName: document.originalName, mimeType: document.mimeType, status: document.status, createdAt: document.createdAt };
}

export function buildTransactionReviews(data) {
  const items = (data.transactions || []).filter((item) => activeStatuses.has(item.status));
  const documents = new Map((data.documents || []).map((document) => [String(document.id), document]));
  const itemDocuments = new Map(items.map((item) => [String(item.id), [...new Set((item.documentIds || []).map(String))].map((id) => documents.get(id)).filter(Boolean)]));
  const byFinancialKey = new Map();
  const byHash = new Map();
  for (const item of items) {
    for (const key of financialKeys(item)) appendIndex(byFinancialKey, key, item);
    for (const document of itemDocuments.get(String(item.id))) if (document.contentHash) appendIndex(byHash, document.contentHash, item);
  }

  return new Map(items.map((item) => {
    const attached = itemDocuments.get(String(item.id));
    const issues = [];
    const duplicateIds = [];
    const duplicates = [];
    if (item.status === "pending") {
      if (item.source !== "manual" && (!Number.isFinite(Number(item.confidence)) || Number(item.confidence) < 0.85)) {
        issues.push({ code: "check_interpretation", message: item.source === "upload" ? "A leitura precisa de conferência. Confira valor, data e situação." : "A interpretação precisa de conferência. Confira valor, data e situação.", fields: ["amount", "date", "paymentState"] });
      }
      if (item.source !== "manual" && (!reviewText(item.category) || reviewText(item.category) === "outros")) {
        issues.push({ code: "check_category", message: "A categoria não foi identificada. Confira se Outros é a melhor opção.", fields: ["category"] });
      }
      const candidates = new Set();
      const sameFile = new Set();
      for (const key of financialKeys(item)) for (const candidate of byFinancialKey.get(key) || []) candidates.add(candidate);
      for (const document of attached) {
        for (const candidate of document.contentHash ? byHash.get(document.contentHash) || [] : []) {
          candidates.add(candidate); sameFile.add(candidate);
        }
      }
      for (const candidate of candidates) {
        if (String(candidate.id) === String(item.id) || (item.recurrenceGroupId && item.recurrenceGroupId === candidate.recurrenceGroupId)) continue;
        const merchant = reviewText(item.merchant);
        const sameMerchant = merchant.length >= 3 && merchant === reviewText(candidate.merchant);
        if (!sameFile.has(candidate) && !sameMerchant && !similarDescription(item.description, candidate.description)) continue;
        duplicates.push({ id: String(candidate.id), description: candidate.description, amount: Number(candidate.amount), kind: candidate.kind, status: candidate.status, transactionDate: candidate.transactionDate, dueDate: candidate.dueDate || null, reason: sameFile.has(candidate) ? "same_document" : "matching_details" });
      }
      duplicates.sort((a, b) => (a.status === "pending") - (b.status === "pending") || a.id.localeCompare(b.id, "en", { numeric: true }));
      duplicateIds.push(...duplicates.map((candidate) => candidate.id));
    }
    return [String(item.id), { documents: attached.map(publicDocument), issues, duplicateIds, duplicates: duplicates.slice(0, 3), duplicateCount: duplicateIds.length, needsAttention: issues.length > 0 || duplicateIds.length > 0 }];
  }));
}

export function withTransactionReviews(data) {
  const reviews = buildTransactionReviews(data);
  return { ...data, transactions: data.transactions.map((item) => ({ ...item, review: reviews.get(String(item.id)) || { documents: [], issues: [], duplicateIds: [], duplicates: [], duplicateCount: 0, needsAttention: false } })) };
}

export function unreviewedDuplicateIds(data, ids, reviewedIds = []) {
  const reviews = buildTransactionReviews(data);
  const reviewed = new Set(reviewedIds.map(String));
  return [...new Set(ids.flatMap((id) => reviews.get(String(id))?.duplicateIds || []))].filter((id) => !reviewed.has(id));
}

export function confirmationIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => !["string", "number"].includes(typeof id) || (typeof id === "number" && (!Number.isSafeInteger(id) || id <= 0)) || !/^[a-zA-Z0-9_-]{1,64}$/.test(String(id)))) {
    throw Object.assign(new Error("Selecione de 1 a 100 lançamentos válidos para salvar."), { status: 400 });
  }
  return [...new Set(ids.map(String))];
}
