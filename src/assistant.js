import { normalizeAssistantTransactions } from "./parser.js";

const allowedStatuses = new Set(["confirmed", "paid", "scheduled"]);

export async function runFinancialAssistant({ message, history, transactions, now = new Date() }) {
  if (!process.env.OPENAI_API_KEY) return null;

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";
  const input = recentConversation(history, message);
  const tools = financialTools();

  try {
    for (let turn = 0; turn < 4; turn += 1) {
      const payload = await createResponse(baseUrl, {
        model,
        store: false,
        instructions: assistantInstructions(now),
        input,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_output_tokens: 1200
      });

      const calls = (payload.output || []).filter((item) => item.type === "function_call");
      if (!calls.length) {
        const answer = responseText(payload);
        return answer ? { kind: "answer", answer } : null;
      }

      input.push(...(payload.output || []));
      for (const call of calls) {
        const args = safeJsonParse(call.arguments);

        if (call.name === "propose_transactions") {
          const proposed = normalizeAssistantTransactions(args.transactions, message, now);
          if (!proposed.length) {
            return { kind: "answer", answer: "Não consegui identificar todos os dados do lançamento. Qual é o valor e a data?" };
          }
          return { kind: "transactions", transactions: proposed };
        }

        if (call.name === "query_finances") {
          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(analyzeTransactions(transactions, args))
          });
        }
      }
    }
  } catch (error) {
    if (process.env.DEBUG_AI === "true") console.error("Financial assistant failed:", error.message);
  }

  return null;
}

export function analyzeTransactions(transactions, filters = {}) {
  const kind = ["income", "expense", "all"].includes(filters.kind) ? filters.kind : "all";
  const status = ["confirmed", "paid", "scheduled", "all"].includes(filters.status) ? filters.status : "all";
  const dateBasis = ["transaction", "due", "auto"].includes(filters.date_basis) ? filters.date_basis : "auto";
  const startDate = isIsoDate(filters.start_date) ? filters.start_date : null;
  const endDate = isIsoDate(filters.end_date) ? filters.end_date : null;
  const category = normalizeFilter(filters.category);
  const search = normalizeFilter(filters.search);
  const groupBy = ["none", "month", "category", "status"].includes(filters.group_by) ? filters.group_by : "none";
  const limit = Math.max(1, Math.min(50, Number(filters.limit) || 20));

  const filtered = transactions
    .filter((item) => allowedStatuses.has(item.status))
    .filter((item) => kind === "all" || item.kind === kind)
    .filter((item) => status === "all" || item.status === status)
    .filter((item) => !category || normalizeFilter(item.category) === category)
    .filter((item) => {
      if (!search) return true;
      return normalizeFilter([item.description, item.merchant, item.category].filter(Boolean).join(" ")).includes(search);
    })
    .filter((item) => {
      const date = transactionDateFor(item, dateBasis);
      return (!startDate || date >= startDate) && (!endDate || date <= endDate);
    })
    .sort((a, b) => transactionDateFor(a, dateBasis).localeCompare(transactionDateFor(b, dateBasis)));

  const income = sum(filtered.filter((item) => item.kind === "income"));
  const expenses = sum(filtered.filter((item) => item.kind === "expense"));
  const groups = groupTransactions(filtered, groupBy, dateBasis);

  return {
    filters: {
      kind,
      status,
      date_basis: dateBasis,
      start_date: startDate,
      end_date: endDate,
      category: filters.category || null,
      search: filters.search || null,
      group_by: groupBy
    },
    summary: {
      count: filtered.length,
      income,
      expenses,
      result: Number((income - expenses).toFixed(2))
    },
    groups,
    items: filtered.slice(0, limit).map((item) => ({
      id: String(item.id),
      kind: item.kind,
      status: item.status,
      amount: Number(item.amount),
      description: item.description,
      merchant: item.merchant || null,
      category: item.category,
      transaction_date: item.transactionDate,
      due_date: item.dueDate || null
    })),
    truncated: filtered.length > limit
  };
}

function recentConversation(history, message) {
  const messages = (history || [])
    .filter((item) => ["user", "assistant"].includes(item.role) && String(item.content || "").trim())
    .slice(-12)
    .map((item) => ({ role: item.role, content: String(item.content).slice(0, 2000) }));

  const last = messages.at(-1);
  if (!last || last.role !== "user" || last.content !== message) {
    messages.push({ role: "user", content: message });
  }
  return messages;
}

function assistantInstructions(now) {
  const today = now.toISOString().slice(0, 10);
  return [
    "Você é o assistente financeiro pessoal do Finup e conversa em português do Brasil.",
    `Hoje é ${today}, no fuso America/Recife. Interprete datas relativas usando essa referência.`,
    "Use propose_transactions quando o usuário quiser registrar receitas, despesas, contas, parcelas ou recorrências.",
    "Nunca invente valor, data, categoria ou recorrência. Se faltar um dado essencial, pergunte de forma curta.",
    "Forma de pagamento e estabelecimento são opcionais: use null e não faça outra pergunta apenas por esses campos.",
    "Compras em mercado, supermercado, mercadinho ou mercearia pertencem à categoria Mercado, mesmo quando o item é alimento.",
    "Em recorrências e parcelamentos, envie uma transação para cada ocorrência, com datas calculadas e descrições curtas.",
    "Expressões como 'por 3 meses', '3 parcelas' ou '3x' são mensais: calcule a primeira data e avance um mês de calendário por ocorrência, preservando o dia quando possível.",
    "Uma conta futura deve ter dueDate e transactionDate na data informada. Uma compra já feita normalmente não tem dueDate.",
    "Use query_finances para responder qualquer pergunta sobre lançamentos, totais, períodos, categorias, comparações ou contas a pagar.",
    "Para contas a pagar use status scheduled e date_basis due. Para comparar meses, consulte o intervalo completo e agrupe por month.",
    "Não afirme que registrou algo antes de chamar propose_transactions. Os lançamentos propostos ainda serão confirmados pelo usuário.",
    "Responda de forma objetiva, amigável e fácil de ler no celular. Mostre valores em reais e datas em DD/MM/AAAA.",
    "Não exponha JSON, nomes de ferramentas, IDs internos ou detalhes técnicos."
  ].join(" ");
}

function financialTools() {
  const nullableString = { type: ["string", "null"] };
  return [
    {
      type: "function",
      name: "propose_transactions",
      description: "Propõe um ou mais lançamentos financeiros para revisão e confirmação do usuário.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          transactions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["income", "expense"] },
                amount: { type: "number" },
                description: { type: "string" },
                merchant: nullableString,
                paymentMethod: { type: ["string", "null"], enum: ["Pix", "Cartao", "Dinheiro", "Boleto", null] },
                transactionDate: { type: "string", format: "date" },
                dueDate: { type: ["string", "null"], format: "date" },
                category: {
                  type: "string",
                  enum: ["Mercado", "Alimentação", "Moradia", "Transporte", "Saúde", "Educação", "Lazer", "Renda", "Outros"]
                },
                confidence: { type: "number" }
              },
              required: ["kind", "amount", "description", "merchant", "paymentMethod", "transactionDate", "dueDate", "category", "confidence"],
              additionalProperties: false
            }
          }
        },
        required: ["transactions"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "query_finances",
      description: "Consulta e agrega os lançamentos reais do controle financeiro ativo.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["income", "expense", "all"] },
          status: { type: "string", enum: ["confirmed", "paid", "scheduled", "all"] },
          date_basis: { type: "string", enum: ["transaction", "due", "auto"] },
          start_date: { type: ["string", "null"], format: "date" },
          end_date: { type: ["string", "null"], format: "date" },
          category: nullableString,
          search: nullableString,
          group_by: { type: "string", enum: ["none", "month", "category", "status"] },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["kind", "status", "date_basis", "start_date", "end_date", "category", "search", "group_by", "limit"],
        additionalProperties: false
      }
    }
  ];
}

async function createResponse(baseUrl, body) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

function responseText(payload) {
  return (payload.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function groupTransactions(items, groupBy, dateBasis) {
  if (groupBy === "none") return [];
  const groups = new Map();
  for (const item of items) {
    const key = groupBy === "month"
      ? transactionDateFor(item, dateBasis).slice(0, 7)
      : groupBy === "category"
        ? item.category
        : item.status;
    const current = groups.get(key) || { key, count: 0, income: 0, expenses: 0 };
    current.count += 1;
    current[item.kind === "income" ? "income" : "expenses"] += Number(item.amount || 0);
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    income: Number(group.income.toFixed(2)),
    expenses: Number(group.expenses.toFixed(2)),
    result: Number((group.income - group.expenses).toFixed(2))
  }));
}

function transactionDateFor(item, basis) {
  if (basis === "due") return item.dueDate || item.transactionDate;
  if (basis === "auto" && item.status === "scheduled") return item.dueDate || item.transactionDate;
  return item.transactionDate;
}

function normalizeFilter(value) {
  return value == null
    ? ""
    : String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sum(items) {
  return Number(items.reduce((total, item) => total + Number(item.amount || 0), 0).toFixed(2));
}
