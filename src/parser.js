const expenseWords = ["paguei", "gastei", "comprei", "despesa", "boleto", "conta", "fatura"];
const incomeWords = ["recebi", "receita", "salario", "salário", "pix recebido", "deposito", "depósito"];
const dueWords = ["vence", "vencimento", "pagar", "boleto"];

const categoryRules = [
  ["Moradia", [/\baluguel\b/, /\bcondominio\b/, /\benergia\b/, /\bluz\b/, /\bagua\b/, /\binternet\b/]],
  ["Mercado", [/\bmercad\w*\b/, /\bsupermercad\w*\b/, /\bmercearia\b/, /\bfeira\b/, /\bhortifruti\b/]],
  ["Alimentação", [/\bifood\b/, /\bdelivery\b/, /\brestaurante\b/, /\bpadaria\b/, /\bpao\b/, /\blanche\b/]],
  ["Transporte", [/\buber\b/, /\b99\b/, /\bgasolina\b/, /\bcombustivel\b/, /\bestacionamento\b/]],
  ["Saúde", [/\bfarmacia\b/, /\bmedico\b/, /\bconsulta\b/, /\bplano de saude\b/]],
  ["Educação", [/\bcurso\b/, /\bfaculdade\b/, /\blivro\b/, /\bescola\b/]],
  ["Lazer", [/\bcinema\b/, /\bbar\b/, /\bshow\b/, /\bviagem\b/, /\bnetflix\b/, /\bspotify\b/]],
  ["Renda", [/\bsalario\b/, /\bfreela\b/, /\brecebi\b/, /\breceita\b/]]
];

export async function parseFinancialMessage(text, now = new Date()) {
  const aiParsed = await parseWithOpenAI(text, now);
  if (aiParsed) return aiParsed;
  return parseFinancialMessageLocally(text, now);
}

function parseFinancialMessageLocally(text, now = new Date()) {
  const normalized = normalizeText(text);
  const amount = extractAmount(normalized);
  const kind = detectKind(normalized);
  const isPayable = kind === "expense" && dueWords.some((word) => normalized.includes(word));
  const date = extractDate(normalized, now);
  const category = detectCategory(normalized, kind);
  const paymentMethod = detectPaymentMethod(normalized);
  const confidence = [amount, kind, date].filter(Boolean).length / 3;

  if (!amount) {
    return {
      intent: "question",
      answer: answerQuestion(normalized),
      confidence: 0.2
    };
  }

  return {
    intent: "transaction",
    transaction: {
      kind,
      status: isPayable ? "scheduled" : "confirmed",
      amount,
      description: buildDescription(text),
      merchant: extractMerchant(text),
      paymentMethod,
      transactionDate: date.transactionDate,
      dueDate: isPayable ? date.dueDate || date.transactionDate : null,
      category,
      source: "chat",
      rawText: text,
      confidence: Number(confidence.toFixed(2))
    }
  };
}

async function parseWithOpenAI(text, now) {
  if (!process.env.OPENAI_API_KEY) return null;

  try {
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Voce extrai dados financeiros pessoais de mensagens em portugues do Brasil. " +
              "Responda somente JSON valido. Se houver transacao, use intent transaction. " +
              "Se for pergunta ou texto sem valor financeiro, use intent question."
          },
          {
            role: "user",
            content: JSON.stringify({
              today: now.toISOString().slice(0, 10),
              message: text,
              schema: {
                intent: "transaction|question",
                answer: "string opcional para question",
                transaction: {
                  kind: "income|expense",
                  amount: "number",
                  description: "string",
                  merchant: "string|null",
                  paymentMethod: "Pix|Cartao|Dinheiro|Boleto|null",
                  transactionDate: "YYYY-MM-DD",
                  dueDate: "YYYY-MM-DD|null",
                  category:
                    "Mercado|Alimentação|Moradia|Transporte|Saúde|Educação|Lazer|Renda|Outros",
                  confidence: "number de 0 a 1"
                }
              }
            })
          }
        ]
      })
    });

    if (!response.ok) return null;
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;
    return normalizeAiResult(JSON.parse(content), text, now);
  } catch {
    return null;
  }
}

function normalizeAiResult(result, rawText, now) {
  if (result?.intent !== "transaction") {
    return {
      intent: "question",
      answer: result?.answer || answerQuestion(normalizeText(rawText)),
      confidence: Number(result?.confidence || 0.5)
    };
  }

  const transaction = result.transaction || {};
  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const kind = transaction.kind === "income" ? "income" : "expense";
  const transactionDate = isIsoDate(transaction.transactionDate)
    ? transaction.transactionDate
    : now.toISOString().slice(0, 10);
  const dueDate = isIsoDate(transaction.dueDate) ? transaction.dueDate : null;

  return {
    intent: "transaction",
    transaction: {
      kind,
      status: dueDate && kind === "expense" ? "scheduled" : "confirmed",
      amount,
      description: String(transaction.description || rawText).trim().slice(0, 160),
      merchant: transaction.merchant ? String(transaction.merchant).trim() : null,
      paymentMethod: transaction.paymentMethod ? String(transaction.paymentMethod).trim() : null,
      transactionDate,
      dueDate,
      category: normalizeCategory(transaction.category, kind),
      source: "chat",
      rawText,
      confidence: Math.max(0, Math.min(1, Number(transaction.confidence || 0.8)))
    }
  };
}

function normalizeCategory(category, kind) {
  const allowed = new Set(["Mercado", "Alimentação", "Moradia", "Transporte", "Saúde", "Educação", "Lazer", "Renda", "Outros"]);
  if (allowed.has(category)) return category;
  return kind === "income" ? "Renda" : "Outros";
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function summarizeTransaction(transaction) {
  const money = transaction.amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const type = transaction.kind === "income" ? "receita" : "despesa";
  const when = formatDate(transaction.transactionDate);
  const due = transaction.dueDate ? ` Vencimento: ${formatDate(transaction.dueDate)}.` : "";
  return `Registrei uma ${type} de ${money} em ${transaction.category}, com data ${when}.${due}`;
}

function extractAmount(text) {
  const patterns = [
    /r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/i,
    /\b(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b/i,
    /\b(?:valor|de|por|gastei|paguei|comprei|recebi)\s+(\d{1,3}(?:\.\d{3})+|\d+)\b/i,
    /\b(\d{1,3}(?:\.\d{3})+|\d+)(?:\s+)(?:reais|real)\b/i
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const integer = match[1].replace(/\./g, "");
  const cents = match[2] || "00";
  return Number(`${integer}.${cents}`);
}

function detectKind(text) {
  if (incomeWords.some((word) => text.includes(word))) return "income";
  if (expenseWords.some((word) => text.includes(word))) return "expense";
  return "expense";
}

function extractDate(text, now) {
  const current = new Date(now);
  const explicit = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  let parsed = new Date(current);

  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]) - 1;
    const year = explicit[3] ? normalizeYear(explicit[3]) : current.getFullYear();
    parsed = new Date(year, month, day);
  } else if (text.includes("ontem")) {
    parsed.setDate(parsed.getDate() - 1);
  } else if (text.includes("amanha") || text.includes("amanhã")) {
    parsed.setDate(parsed.getDate() + 1);
  }

  const iso = parsed.toISOString().slice(0, 10);
  return { transactionDate: iso, dueDate: iso };
}

function normalizeYear(value) {
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
}

function detectCategory(text, kind) {
  for (const [category, patterns] of categoryRules) {
    if (patterns.some((pattern) => pattern.test(text))) return category;
  }
  return kind === "income" ? "Renda" : "Outros";
}

function detectPaymentMethod(text) {
  if (text.includes("pix")) return "Pix";
  if (text.includes("cartao") || text.includes("cartão")) return "Cartao";
  if (text.includes("dinheiro")) return "Dinheiro";
  if (text.includes("boleto")) return "Boleto";
  return null;
}

function extractMerchant(text) {
  const match = text.match(/\b(?:no|na|em|para|com)\s+([A-Za-zÀ-ÿ0-9 ]{3,40})/);
  return match ? match[1].trim() : null;
}

function buildDescription(text) {
  return text.trim().replace(/\s+/g, " ").slice(0, 160);
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function answerQuestion(text) {
  if (text.includes("quanto") || text.includes("gastei")) {
    return "Ainda estou aprendendo a responder perguntas analiticas. Por enquanto, use o painel ao lado para acompanhar seus totais.";
  }
  return "Nao encontrei um valor financeiro nessa mensagem. Tente algo como: paguei R$ 89,90 no mercado hoje.";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}
