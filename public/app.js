const state = {
  currency: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }),
  activePanel: "summary",
  categoryKind: "expense",
  ledgerFilters: {
    kind: "all",
    period: "current-month",
    category: ""
  },
  allTransactions: [],
  session: null,
  authMode: new URLSearchParams(window.location.search).has("reset") ? "reset" : "login",
  resetToken: new URLSearchParams(window.location.search).get("reset")
};

const elements = {
  authScreen: document.querySelector("#auth-screen"),
  appShell: document.querySelector("#app-shell"),
  authForm: document.querySelector("#auth-form"),
  authNameField: document.querySelector("#auth-name-field"),
  authEmailField: document.querySelector("#auth-email-field"),
  authPasswordField: document.querySelector("#auth-password-field"),
  authName: document.querySelector("#auth-name"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  authRememberField: document.querySelector("#auth-remember-field"),
  authRemember: document.querySelector("#auth-remember"),
  authError: document.querySelector("#auth-error"),
  authHelp: document.querySelector("#auth-help"),
  forgotPasswordButton: document.querySelector("#forgot-password-button"),
  backLoginButton: document.querySelector("#back-login-button"),
  userName: document.querySelector("#user-name"),
  controlSelect: document.querySelector("#control-select"),
  newControlButton: document.querySelector("#new-control-button"),
  shareControlButton: document.querySelector("#share-control-button"),
  logoutButton: document.querySelector("#logout-button"),
  income: document.querySelector("#income"),
  expenses: document.querySelector("#expenses"),
  result: document.querySelector("#result"),
  payable: document.querySelector("#payable"),
  dashboardFilters: document.querySelectorAll("[data-dashboard-filter]"),
  categories: document.querySelector("#categories"),
  insights: document.querySelector("#insights"),
  categoryKindButtons: document.querySelectorAll("[data-category-kind]"),
  documents: document.querySelector("#documents"),
  messages: document.querySelector("#messages"),
  pendingTransactions: document.querySelector("#pending-transactions"),
  transactions: document.querySelector("#transactions"),
  ledgerTitle: document.querySelector("#ledger-title"),
  ledgerFilterSummary: document.querySelector("#ledger-filter-summary"),
  ledgerKindFilter: document.querySelector("#ledger-kind-filter"),
  ledgerPeriodFilter: document.querySelector("#ledger-period-filter"),
  ledgerCategoryFilter: document.querySelector("#ledger-category-filter"),
  clearLedgerFilters: document.querySelector("#clear-ledger-filters"),
  form: document.querySelector("#chat-form"),
  input: document.querySelector("#message-input"),
  fileInput: document.querySelector("#file-input"),
  panels: document.querySelectorAll("[data-panel]"),
  tabs: document.querySelectorAll("[data-tab]"),
  pendingBadge: document.querySelector("#pending-badge"),
  filesBadge: document.querySelector("#files-badge")
};

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => activatePanel(tab.dataset.tab));
});

elements.dashboardFilters.forEach((card) => {
  const open = () => applyDashboardFilter(card.dataset.dashboardFilter);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
});

elements.categoryKindButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.categoryKind = button.dataset.categoryKind;
    elements.categoryKindButtons.forEach((item) => item.classList.toggle("active", item === button));
    renderCategories(state.lastSummary || { expenseCategories: [], incomeCategories: [], categories: [] });
  });
});

[elements.ledgerKindFilter, elements.ledgerPeriodFilter, elements.ledgerCategoryFilter].forEach((element) => {
  element.addEventListener("input", () => {
    state.ledgerFilters = {
      kind: elements.ledgerKindFilter.value,
      period: elements.ledgerPeriodFilter.value,
      category: elements.ledgerCategoryFilter.value.trim()
    };
    renderTransactions(state.allTransactions);
  });
});

elements.clearLedgerFilters.addEventListener("click", () => {
  setLedgerFilters({ kind: "all", period: "current-month", category: "" });
  renderTransactions(state.allTransactions);
});

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.authMode === "reset") {
    await resetPassword();
    return;
  }
  if (state.authMode === "forgot") {
    await requestPasswordReset();
    return;
  }
  if (state.authMode === "register") {
    await submitAuth("register");
    return;
  }
  await submitAuth("login");
});

document.querySelector('[data-auth-action="register"]').addEventListener("click", async () => {
  if (state.authMode === "register") {
    setAuthMode("login");
    return;
  }
  if (state.authMode !== "register") {
    setAuthMode("register");
    return;
  }
});

elements.forgotPasswordButton.addEventListener("click", async () => {
  if (state.authMode !== "forgot") {
    setAuthMode("forgot");
    return;
  }
  await requestPasswordReset();
});

elements.backLoginButton.addEventListener("click", () => {
  history.replaceState(null, "", window.location.pathname);
  state.resetToken = null;
  setAuthMode("login");
});

elements.logoutButton.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  state.session = null;
  showAuth();
});

elements.controlSelect.addEventListener("change", async () => {
  await postJson("/api/controls/select", { controlId: elements.controlSelect.value });
  await loadSession();
  await loadState();
});

elements.newControlButton.addEventListener("click", async () => {
  const name = prompt("Nome do novo controle financeiro");
  if (!name?.trim()) return;
  await postJson("/api/controls", { name: name.trim() });
  await loadSession();
  await loadState();
});

elements.shareControlButton.addEventListener("click", async () => {
  const email = prompt("E-mail do usuário cadastrado para compartilhar este controle");
  if (!email?.trim()) return;
  await postJson("/api/controls/share", { email: email.trim() });
  await loadSession();
});

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
  const response = await fetch("/api/upload", { method: "POST", body });
  elements.fileInput.value = "";
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Falha ao enviar arquivo." }));
    renderLocalError(error.error || error.detail || "Falha ao enviar arquivo.");
    return;
  }
  await loadState();
});

init();

async function init() {
  setAuthMode(state.authMode);
  await loadSession();
  if (state.session?.user && state.authMode !== "reset") {
    showApp();
    await loadState();
  } else {
    showAuth();
  }
}

async function loadSession() {
  const response = await fetch("/api/session");
  state.session = await response.json();
  renderSession();
}

async function loadState() {
  const response = await fetch("/api/state");
  if (response.status === 401 || response.status === 403) {
    showAuth();
    return;
  }
  const data = await response.json();
  if (!response.ok || !data?.summary) {
    if (!state.session?.user) {
      showAuth();
      return;
    }
    showAuthError(data?.error || "Nao consegui carregar os dados agora.");
    return;
  }
  render(data);
}

async function postJson(url, payload) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function submitAuth(action) {
  clearAuthMessages();
  const payload = {
    name: elements.authName.value.trim(),
    email: elements.authEmail.value.trim(),
    password: elements.authPassword.value,
    remember: elements.authRemember.checked
  };

  const response = await postJson(`/api/auth/${action}`, payload);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Falha ao autenticar." }));
    elements.authError.textContent = error.error || "Falha ao autenticar.";
    elements.authError.hidden = false;
    return;
  }

  await loadSession();
  showApp();
  await loadState();
}

function showAuth() {
  elements.authScreen.hidden = false;
  elements.appShell.hidden = true;
  setAuthMode(state.authMode);
}

function showApp() {
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
}

function renderSession() {
  const controls = state.session?.controls || [];
  elements.userName.textContent = state.session?.user?.name || "";
  elements.controlSelect.innerHTML = controls
    .map((control) => `<option value="${escapeAttribute(control.id)}">${escapeHtml(control.name)}</option>`)
    .join("");
  if (state.session?.activeControlId) {
    elements.controlSelect.value = state.session.activeControlId;
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const loginMode = mode === "login";
  const registerMode = mode === "register";
  const forgotMode = mode === "forgot";
  const resetMode = mode === "reset";
  const submitButton = document.querySelector('[data-auth-action="login"]');
  const registerButton = document.querySelector('[data-auth-action="register"]');
  const subtitle = document.querySelector(".auth-card .brand span");

  elements.authNameField.hidden = !registerMode;
  elements.authEmailField.hidden = resetMode;
  elements.authPasswordField.hidden = forgotMode;
  elements.authRememberField.hidden = !loginMode;
  registerButton.hidden = forgotMode || resetMode;
  elements.forgotPasswordButton.hidden = resetMode || registerMode;
  elements.backLoginButton.hidden = loginMode || registerMode;
  elements.authEmail.required = !resetMode;
  elements.authPassword.required = !forgotMode;
  elements.authName.required = registerMode;

  if (loginMode) {
    subtitle.textContent = "entrar na conta";
    submitButton.textContent = "Entrar";
    registerButton.textContent = "Criar conta";
    elements.forgotPasswordButton.textContent = "Esqueci minha senha";
    elements.authPassword.placeholder = "";
  } else if (registerMode) {
    subtitle.textContent = "criar nova conta";
    submitButton.textContent = "Criar conta";
    registerButton.textContent = "Ja tenho conta";
    elements.forgotPasswordButton.textContent = "Esqueci minha senha";
    elements.authPassword.placeholder = "";
  } else if (forgotMode) {
    subtitle.textContent = "recuperar acesso";
    submitButton.textContent = "Entrar";
    elements.forgotPasswordButton.textContent = "Enviar link de recuperação";
    elements.authPassword.placeholder = "Senha atual";
  } else {
    subtitle.textContent = "definir nova senha";
    submitButton.textContent = "Salvar nova senha";
    elements.authPassword.placeholder = "Nova senha";
  }
  clearAuthMessages();
}

async function requestPasswordReset() {
  clearAuthMessages();
  const email = elements.authEmail.value.trim();
  if (!email) {
    showAuthError("Informe seu e-mail para receber o link.");
    return;
  }
  const response = await postJson("/api/auth/forgot", { email });
  if (!response.ok) {
    showAuthError("Nao consegui enviar o link agora. Tente novamente.");
    return;
  }
  showAuthHelp("Se este e-mail estiver cadastrado, enviaremos um link para redefinir sua senha.");
}

async function resetPassword() {
  clearAuthMessages();
  const password = elements.authPassword.value;
  if (password.length < 6) {
    showAuthError("A nova senha precisa ter pelo menos 6 caracteres.");
    return;
  }
  const response = await postJson("/api/auth/reset", { token: state.resetToken, password });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Link invalido ou expirado." }));
    showAuthError(error.error || "Link invalido ou expirado.");
    return;
  }
  history.replaceState(null, "", window.location.pathname);
  state.resetToken = null;
  elements.authPassword.value = "";
  setAuthMode("login");
  showAuthHelp("Senha alterada. Agora voce ja pode entrar.");
}

function clearAuthMessages() {
  elements.authError.hidden = true;
  elements.authHelp.hidden = true;
}

function showAuthError(message) {
  elements.authError.textContent = message;
  elements.authError.hidden = false;
}

function showAuthHelp(message) {
  elements.authHelp.textContent = message;
  elements.authHelp.hidden = false;
}

function render(data) {
  state.lastSummary = data.summary;
  state.allTransactions = data.transactions || [];
  elements.income.textContent = money(data.summary.income);
  elements.expenses.textContent = money(data.summary.expenses);
  elements.result.textContent = money(data.summary.result);
  elements.payable.textContent = money(data.summary.payableTotal);

  renderMessages(data.messages, data.pendingTransactions || []);
  renderCategories(data.summary);
  renderInsights(data.summary);
  renderDocuments(data.documents);
  renderPendingTransactions(data.pendingTransactions || []);
  renderTransactions(state.allTransactions);
  updateBadges(data);
}

function renderLocalError(message) {
  const currentMessages = [...elements.messages.querySelectorAll(".message")];
  elements.messages.innerHTML = [
    ...currentMessages.map((messageElement) => messageElement.outerHTML),
    `
      <article class="message assistant">
        <p>${escapeHtml(message)}</p>
        <span class="message-time">${formatDateTime(new Date().toISOString())}</span>
      </article>
    `
  ].join("");
  elements.messages.scrollTop = elements.messages.scrollHeight;
  activatePanel("chat");
}

function activatePanel(name) {
  state.activePanel = name;
  elements.panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
  elements.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  if (name === "chat") {
    requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }
}

function updateBadges(data) {
  setBadge(elements.pendingBadge, (data.pendingTransactions || []).length);
  setBadge(elements.filesBadge, (data.documents || []).filter((item) => item.status !== "processed").length);
}

function setBadge(element, count) {
  element.textContent = String(count);
  element.hidden = count === 0;
}

function renderMessages(messages, pendingTransactions = []) {
  const actionableMessageIndex = findActionableMessageIndex(messages, pendingTransactions);
  elements.messages.innerHTML = messages
    .map((message, index) => {
      const actions = index === actionableMessageIndex ? renderChatPendingActions(pendingTransactions) : "";
      return `
        <article class="message ${escapeHtml(message.role)}">
          <p>${escapeHtml(message.content)}</p>
          ${actions}
          <span class="message-time">${formatDateTime(message.createdAt)}</span>
        </article>
      `;
    })
    .join("");

  elements.messages.querySelectorAll("[data-chat-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.chatAction;
      button.disabled = true;

      if (action === "review") {
        activatePanel("review");
        return;
      }

      const targetIds = action === "confirm-all" || action === "dismiss-all"
        ? pendingTransactions.map((transaction) => transaction.id)
        : [button.dataset.id];
      const endpointAction = action.startsWith("confirm") ? "confirm" : "dismiss";

      for (const id of targetIds) {
        await fetch(`/api/transactions/${encodeURIComponent(id)}/${endpointAction}`, { method: "POST" });
      }
      await loadState();
    });
  });
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function findActionableMessageIndex(messages, pendingTransactions) {
  if (!pendingTransactions.length) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && /confira os dados/i.test(message.content)) {
      return index;
    }
  }
  return -1;
}

function renderChatPendingActions(pendingTransactions) {
  if (!pendingTransactions.length) return "";

  const rows = pendingTransactions.slice(0, 5).map((transaction) => {
    const date = transaction.dueDate || transaction.transactionDate;
    return `
      <div class="chat-pending-row">
        <div>
          <strong>${escapeHtml(transaction.description)}</strong>
          <span>${money(transaction.amount)} · ${escapeHtml(transaction.category)} · ${formatDate(date)}</span>
        </div>
        <div class="chat-pending-actions">
          <button type="button" data-chat-action="confirm" data-id="${escapeHtml(transaction.id)}">Confirmar</button>
          <button type="button" data-chat-action="dismiss" data-id="${escapeHtml(transaction.id)}">Descartar</button>
        </div>
      </div>
    `;
  }).join("");

  const extra = pendingTransactions.length > 5
    ? `<p class="chat-pending-extra">Mais ${pendingTransactions.length - 5} pendência(s) na aba Revisar.</p>`
    : "";
  const bulkActions = pendingTransactions.length > 1
    ? `
      <button type="button" data-chat-action="confirm-all">Confirmar todos</button>
      <button type="button" data-chat-action="dismiss-all">Descartar todos</button>
    `
    : "";

  return `
    <div class="chat-pending-card">
      ${rows}
      ${extra}
      <div class="chat-bulk-actions">
        ${bulkActions}
        <button type="button" data-chat-action="review">Revisar/editar</button>
      </div>
    </div>
  `;
}

function renderCategories(summary) {
  const categories =
    state.categoryKind === "income"
      ? summary.incomeCategories || []
      : summary.expenseCategories || summary.categories || [];
  const label = state.categoryKind === "income" ? "receitas" : "despesas";

  if (!categories.length) {
    elements.categories.innerHTML = `<p class="empty">Sem ${label} categorizadas neste mes.</p>`;
    return;
  }

  const max = Math.max(...categories.map((category) => category.amount));
  elements.categories.innerHTML = categories
    .map((category) => {
      const width = Math.max(6, Math.round((category.amount / max) * 100));
      return `
        <article class="category-row ${escapeHtml(state.categoryKind)}" data-category-filter="${escapeAttribute(category.name)}" tabindex="0" role="button" aria-label="Ver lançamentos de ${escapeAttribute(category.name)}">
          <strong>${escapeHtml(category.name)}</strong>
          <span>${money(category.amount)}</span>
          <div class="bar"><span style="width:${width}%"></span></div>
        </article>
      `;
    })
    .join("");

  elements.categories.querySelectorAll("[data-category-filter]").forEach((row) => {
    const open = () => applyCategoryFilter(row.dataset.categoryFilter);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function applyDashboardFilter(filter) {
  const nextFilters = {
    income: { kind: "income", period: "current-month", category: "" },
    expense: { kind: "expense", period: "current-month", category: "" },
    result: { kind: "all", period: "current-month", category: "" },
    payable: { kind: "payable", period: "upcoming", category: "" }
  }[filter] || { kind: "all", period: "current-month", category: "" };

  setLedgerFilters(nextFilters);
  renderTransactions(state.allTransactions);
  activatePanel("review");
}

function applyCategoryFilter(category) {
  setLedgerFilters({
    kind: state.categoryKind,
    period: "current-month",
    category
  });
  renderTransactions(state.allTransactions);
  activatePanel("review");
}

function setLedgerFilters(filters) {
  state.ledgerFilters = { ...state.ledgerFilters, ...filters };
  elements.ledgerKindFilter.value = state.ledgerFilters.kind;
  elements.ledgerPeriodFilter.value = state.ledgerFilters.period;
  elements.ledgerCategoryFilter.value = state.ledgerFilters.category;
}

function renderInsights(summary) {
  const series = summary.monthlySeries || [];
  if (!series.length) {
    elements.insights.innerHTML = `<p class="empty">Os graficos aparecem quando houver lancamentos confirmados.</p>`;
    return;
  }

  const current = series.at(-1) || {};
  const previous = series.at(-2) || {};
  const incomeDelta = Number(current.income || 0) - Number(previous.income || 0);
  const expenseDelta = Number(current.expenses || 0) - Number(previous.expenses || 0);
  const resultDelta = Number(current.result || 0) - Number(previous.result || 0);

  elements.insights.innerHTML = `
    <article class="insight-card">
      <div class="insight-title">
        <strong>Evolução mensal</strong>
        <span>Últimos ${series.length} meses</span>
      </div>
      ${renderMonthlyChart(series)}
    </article>
    <article class="insight-card">
      <div class="insight-title">
        <strong>Comparação mensal</strong>
        <span>${escapeHtml(previous.label || "Mês anterior")} → ${escapeHtml(current.label || "Atual")}</span>
      </div>
      <div class="comparison-list">
        ${renderComparisonRow("Receitas", incomeDelta, "income")}
        ${renderComparisonRow("Despesas", expenseDelta, "expense")}
        ${renderComparisonRow("Resultado", resultDelta, resultDelta >= 0 ? "income" : "expense")}
      </div>
    </article>
    <article class="insight-card">
      <div class="insight-title">
        <strong>Resultado acumulado</strong>
        <span>Receitas menos despesas</span>
      </div>
      <strong class="big-number ${Number(summary.result || 0) >= 0 ? "income" : "expense"}">${money(summary.result)}</strong>
      <span class="transaction-meta">Neste mês</span>
    </article>
  `;
}

function renderMonthlyChart(series) {
  const max = Math.max(1, ...series.flatMap((item) => [Number(item.income || 0), Number(item.expenses || 0)]));
  return `
    <div class="monthly-chart" role="img" aria-label="Comparativo mensal de receitas e despesas">
      ${series.map((item) => {
        const incomeHeight = Math.max(4, Math.round((Number(item.income || 0) / max) * 92));
        const expenseHeight = Math.max(4, Math.round((Number(item.expenses || 0) / max) * 92));
        return `
          <div class="month-bars">
            <div class="bars">
              <span class="income-bar" style="height:${incomeHeight}%"></span>
              <span class="expense-bar" style="height:${expenseHeight}%"></span>
            </div>
            <small>${escapeHtml(item.shortLabel || item.label)}</small>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderComparisonRow(label, delta, kind) {
  const sign = delta > 0 ? "+" : "";
  return `
    <div class="comparison-row">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeHtml(kind)}">${sign}${money(delta)}</strong>
    </div>
  `;
}

function renderDocuments(documents) {
  if (!documents.length) {
    elements.documents.innerHTML = `<p class="empty">Nenhum arquivo enviado ainda.</p>`;
    return;
  }

  elements.documents.innerHTML = documents
    .map(
      (document) => `
        <article class="document-row">
          <div>
            <strong>${escapeHtml(document.originalName)}</strong>
            <span class="transaction-meta">${escapeHtml(document.status)} · ${formatDateTime(document.createdAt)}</span>
          </div>
          <a class="open-file-button" href="/api/documents/${encodeURIComponent(document.id)}/view" target="_blank" rel="noopener">Abrir</a>
        </article>
      `
    )
    .join("");
}

function renderTransactions(transactions) {
  syncLedgerFilterControls();
  const filteredTransactions = filterTransactions(transactions);
  renderLedgerFilterSummary(filteredTransactions.length);

  if (!filteredTransactions.length) {
    elements.transactions.innerHTML = `<p class="empty">Nenhum lançamento encontrado para este filtro.</p>`;
    return;
  }

  elements.transactions.innerHTML = filteredTransactions
    .map(
      (transaction) => `
        <article class="transaction-row confirmed-row" data-id="${escapeHtml(transaction.id)}">
          <div>
            <strong>${escapeHtml(transaction.description)}</strong>
            <div class="transaction-meta">
              ${escapeHtml(transaction.category)} · ${formatDate(transaction.transactionDate)}
              ${transaction.dueDate ? ` · vence ${formatDate(transaction.dueDate)}` : ""}
            </div>
          </div>
          <div class="transaction-meta">
            <span class="transaction-value ${escapeHtml(transaction.kind)}">${money(transaction.amount)}</span>
            <button type="button" class="danger-button" data-action="remove" data-id="${escapeHtml(transaction.id)}">Remover</button>
          </div>
        </article>
      `
    )
    .join("");

  elements.transactions.querySelectorAll("button[data-action='remove']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      const card = button.closest(".transaction-row");
      const description = card.querySelector("strong")?.textContent || "este lançamento";
      if (!confirm(`Remover ${description}?`)) return;
      button.disabled = true;
      await fetch(`/api/transactions/${encodeURIComponent(id)}/remove`, { method: "POST" });
      await loadState();
    });
  });
}

function filterTransactions(transactions) {
  const { kind, period, category } = state.ledgerFilters;
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const normalizedCategory = normalizeText(category);

  return transactions.filter((transaction) => {
    const date = transaction.dueDate || transaction.transactionDate;
    if (kind === "payable") {
      if (transaction.status !== "scheduled") return false;
    } else if (kind !== "all" && transaction.kind !== kind) {
      return false;
    }

    if (period === "current-month" && !String(transaction.transactionDate).startsWith(currentMonth)) return false;
    if (period === "upcoming" && String(date) < today) return false;
    if (normalizedCategory && normalizeText(transaction.category) !== normalizedCategory) return false;
    return true;
  });
}

function renderLedgerFilterSummary(count) {
  const { kind, period, category } = state.ledgerFilters;
  const kindLabel = {
    all: "Todos os lançamentos",
    income: "Receitas",
    expense: "Despesas",
    payable: "Contas a pagar"
  }[kind] || "Lançamentos";
  const periodLabel = {
    "current-month": "do mês atual",
    upcoming: "com vencimento futuro",
    all: "de todo o histórico"
  }[period] || "";
  const categoryLabel = category ? ` em ${category}` : "";

  elements.ledgerTitle.textContent = kindLabel;
  elements.ledgerFilterSummary.textContent = `${count} item(ns) ${periodLabel}${categoryLabel}.`;
}

function syncLedgerFilterControls() {
  if (elements.ledgerKindFilter.value !== state.ledgerFilters.kind) elements.ledgerKindFilter.value = state.ledgerFilters.kind;
  if (elements.ledgerPeriodFilter.value !== state.ledgerFilters.period) elements.ledgerPeriodFilter.value = state.ledgerFilters.period;
  if (elements.ledgerCategoryFilter.value !== state.ledgerFilters.category) elements.ledgerCategoryFilter.value = state.ledgerFilters.category;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function renderPendingTransactions(transactions) {
  if (!transactions.length) {
    elements.pendingTransactions.innerHTML = `<p class="empty">Nenhum lançamento pendente.</p>`;
    return;
  }

  elements.pendingTransactions.innerHTML = transactions
    .map(
      (transaction) => `
        <article class="transaction-row pending-row" data-id="${escapeHtml(transaction.id)}">
          <form class="review-form">
            <label>
              <span>Descrição</span>
              <input name="description" value="${escapeAttribute(transaction.description)}" />
            </label>
            <div class="review-grid">
              <label>
                <span>Valor</span>
                <input name="amount" inputmode="decimal" value="${Number(transaction.amount).toFixed(2)}" />
              </label>
              <label>
                <span>Tipo</span>
                <select name="kind">
                  <option value="expense" ${transaction.kind === "expense" ? "selected" : ""}>Despesa</option>
                  <option value="income" ${transaction.kind === "income" ? "selected" : ""}>Receita</option>
                </select>
              </label>
              <label>
                <span>Categoria</span>
                <input name="category" list="category-options" value="${escapeAttribute(transaction.category)}" />
              </label>
              <label>
                <span>Data</span>
                <input name="transactionDate" type="date" value="${escapeAttribute(transaction.transactionDate)}" />
              </label>
            </div>
            <div class="review-grid optional-grid">
              <label>
                <span>Forma</span>
                <input name="paymentMethod" value="${escapeAttribute(transaction.paymentMethod || "")}" placeholder="Pix, cartão..." />
              </label>
              <label>
                <span>Vencimento</span>
                <input name="dueDate" type="date" value="${escapeAttribute(transaction.dueDate || "")}" />
              </label>
            </div>
          </form>
          <div class="review-actions">
            <button type="button" data-action="confirm" data-id="${escapeHtml(transaction.id)}">Confirmar</button>
            <button type="button" data-action="update" data-id="${escapeHtml(transaction.id)}">Salvar edição</button>
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
      if (action === "update") {
        const card = button.closest(".pending-row");
        const form = card.querySelector(".review-form");
        await postJson(`/api/transactions/${encodeURIComponent(id)}/update`, Object.fromEntries(new FormData(form)));
      } else {
        await fetch(`/api/transactions/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      }
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

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
