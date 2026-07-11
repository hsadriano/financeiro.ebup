const state = {
  currency: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
};

const elements = {
  income: document.querySelector("#income"),
  expenses: document.querySelector("#expenses"),
  result: document.querySelector("#result"),
  payable: document.querySelector("#payable"),
  categories: document.querySelector("#categories"),
  documents: document.querySelector("#documents"),
  messages: document.querySelector("#messages"),
  pendingTransactions: document.querySelector("#pending-transactions"),
  transactions: document.querySelector("#transactions"),
  form: document.querySelector("#chat-form"),
  input: document.querySelector("#message-input"),
  fileInput: document.querySelector("#file-input")
};

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message) return;
  elements.input.value = "";
  await postJson("/api/chat", { message });
  await loadState();
});

elements.fileInput.addEventListener("change", async () => {
  const [file] = elements.fileInput.files;
  if (!file) return;

  const body = new FormData();
  body.append("file", file);
  await fetch("/api/upload", { method: "POST", body });
  elements.fileInput.value = "";
  await loadState();
});

loadState();

async function loadState() {
  const response = await fetch("/api/state");
  const data = await response.json();
  render(data);
}

async function postJson(url, payload) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function render(data) {
  elements.income.textContent = money(data.summary.income);
  elements.expenses.textContent = money(data.summary.expenses);
  elements.result.textContent = money(data.summary.result);
  elements.payable.textContent = money(data.summary.payableTotal);

  renderMessages(data.messages);
  renderCategories(data.summary.categories);
  renderDocuments(data.documents);
  renderPendingTransactions(data.pendingTransactions || []);
  renderTransactions(data.transactions);
}

function renderMessages(messages) {
  elements.messages.innerHTML = messages
    .map(
      (message) => `
        <article class="message ${escapeHtml(message.role)}">
          <p>${escapeHtml(message.content)}</p>
          <span class="message-time">${formatDateTime(message.createdAt)}</span>
        </article>
      `
    )
    .join("");
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderCategories(categories) {
  if (!categories.length) {
    elements.categories.innerHTML = `<p class="empty">Sem despesas categorizadas neste mes.</p>`;
    return;
  }

  const max = Math.max(...categories.map((category) => category.amount));
  elements.categories.innerHTML = categories
    .map((category) => {
      const width = Math.max(6, Math.round((category.amount / max) * 100));
      return `
        <article class="category-row">
          <strong>${escapeHtml(category.name)}</strong>
          <span>${money(category.amount)}</span>
          <div class="bar"><span style="width:${width}%"></span></div>
        </article>
      `;
    })
    .join("");
}

function renderDocuments(documents) {
  if (!documents.length) {
    elements.documents.innerHTML = `<p class="empty">Nenhum arquivo enviado ainda.</p>`;
    return;
  }

  elements.documents.innerHTML = documents
    .slice(0, 6)
    .map(
      (document) => `
        <article class="document-row">
          <strong>${escapeHtml(document.originalName)}</strong>
          <span class="transaction-meta">${escapeHtml(document.status)} · ${formatDateTime(document.createdAt)}</span>
        </article>
      `
    )
    .join("");
}

function renderTransactions(transactions) {
  if (!transactions.length) {
    elements.transactions.innerHTML = `<p class="empty">Os lancamentos aparecem aqui quando voce conversar comigo.</p>`;
    return;
  }

  elements.transactions.innerHTML = transactions
    .map(
      (transaction) => `
        <article class="transaction-row">
          <strong>${escapeHtml(transaction.description)}</strong>
          <span class="transaction-value ${escapeHtml(transaction.kind)}">${money(transaction.amount)}</span>
          <div class="transaction-meta">
            ${escapeHtml(transaction.category)} · ${formatDate(transaction.transactionDate)}
            ${transaction.dueDate ? ` · vence ${formatDate(transaction.dueDate)}` : ""}
          </div>
        </article>
      `
    )
    .join("");
}

function renderPendingTransactions(transactions) {
  if (!transactions.length) {
    elements.pendingTransactions.innerHTML = `<p class="empty">Nenhum lançamento pendente.</p>`;
    return;
  }

  elements.pendingTransactions.innerHTML = transactions
    .map(
      (transaction) => `
        <article class="transaction-row pending-row">
          <strong>${escapeHtml(transaction.description)}</strong>
          <span class="transaction-value ${escapeHtml(transaction.kind)}">${money(transaction.amount)}</span>
          <div class="transaction-meta">
            ${escapeHtml(transaction.category)} · ${formatDate(transaction.transactionDate)}
            ${transaction.dueDate ? ` · vence ${formatDate(transaction.dueDate)}` : ""}
          </div>
          <div class="review-actions">
            <button type="button" data-action="confirm" data-id="${escapeHtml(transaction.id)}">Confirmar</button>
            <button type="button" data-action="dismiss" data-id="${escapeHtml(transaction.id)}">Descartar</button>
          </div>
        </article>
      `
    )
    .join("");

  elements.pendingTransactions.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      const action = button.dataset.action;
      button.disabled = true;
      await fetch(`/api/transactions/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      await loadState();
    });
  });
}

function money(value) {
  return state.currency.format(Number(value || 0));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
