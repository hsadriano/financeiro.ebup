import { localDate, groupDrafts, captureDrafts, seriesTargets, filterLedger, settledTotals } from "/ui-model.js?v=20261118-1";

const $ = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
const date = (value) => value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value.slice(0, 10) + "T12:00:00Z")) : "Sem data";
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
const icons = () => window.lucide?.createIcons({ attrs: { "stroke-width": 1.8, "aria-hidden": "true" } });
const state = {
  session: null, data: null, panel: "home", back: "home", busy: false, captureIds: [],
  selected: new Set(), selecting: false, billFilter: "open", category: "expense",
  detailId: null, bulkAnchor: null, audio: null, stream: null, chunks: [], timer: null,
  ledgerLimit: 50, documentLimit: 50, messageLimit: 60,
  audioOrigin: "capture", chatDrafts: new Map(),
  authMode: new URLSearchParams(location.search).has("reset") ? "reset" : "login",
  filters: { kind: "all", period: "current-month", category: "", wallet: "", search: "" }
};
let toastTimer;
let toastUndo;
let audioRequest = 0;

async function request(url, body, multipart = false) {
  let response;
  try {
    response = await fetch(url, body === undefined ? {} : {
      method: "POST", headers: multipart ? {} : { "Content-Type": "application/json" },
      body: multipart ? body : JSON.stringify(body)
    });
  } catch {
    throw new Error("Conexão interrompida. Confira os itens para revisar antes de enviar novamente.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.includes("/auth/")) {
    showAuth();
    throw new Error("Sua sessão terminou. Entre novamente.");
  }
  if (!response.ok) throw new Error(data.error === "Erro interno"
    ? "Não foi possível concluir agora. Seus dados já salvos continuam disponíveis."
    : data.error || "Não foi possível concluir. Tente novamente.");
  return data;
}

async function task(action, target) {
  if (state.busy) return;
  if (state.audio || state.audioStarting) { toast("Finalize ou cancele a gravação antes de continuar."); return; }
  state.busy = true;
  all("button:not(:disabled), select#control-select").forEach((button) => { button.dataset.unlock = "true"; button.disabled = true; });
  if (target) $(target).hidden = true;
  try { await action(); }
  catch (error) { target ? feedback(target, error.message, true) : toast(error.message); }
  finally {
    state.busy = false;
    all("[data-unlock]").forEach((button) => { button.disabled = false; delete button.dataset.unlock; });
  }
}

function feedback(target, text, isError = false) {
  $(target).textContent = text;
  $(target).classList.toggle("error", isError);
  $(target).hidden = false;
}

function toast(text, undo) {
  clearTimeout(toastTimer);
  toastUndo = undo;
  $("toast-text").textContent = text;
  $("toast-action").hidden = !undo;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; toastUndo = null; }, undo ? 12000 : 8000);
}
$("toast-close").onclick = () => { $("toast").hidden = true; };
$("toast-action").onclick = () => task(async () => {
  const undo = toastUndo;
  $("toast").hidden = true;
  if (undo) await undo();
});

function openPanel(name) {
  if (!state.data) { toast("Carregue o espaço financeiro antes de continuar."); return; }
  if (name !== state.panel) state.back = state.panel;
  state.panel = name;
  all("[data-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
  all("[data-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
    if (tab.dataset.tab === name) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  if (name === "chat") requestAnimationFrame(() => { $("messages").scrollTop = $("messages").scrollHeight; });
  else document.querySelector('[data-panel="' + name + '"]').scrollTop = 0;
}
all("[data-open]").forEach((button) => { button.onclick = () => openPanel(button.dataset.open); });
all("[data-tab]").forEach((button) => { button.onclick = () => openPanel(button.dataset.tab); });
all("[data-back]").forEach((button) => { button.onclick = () => openPanel(["pending", "files", "reports", "settings"].includes(state.back) ? "home" : state.back); });
$("profile-button").onclick = () => openPanel("settings");

function openSheet(id) {
  if (!$(id).open) $(id).showModal();
  icons();
}
all("[data-close]").forEach((button) => { button.onclick = () => { if (!state.audio && !state.audioStarting) $(button.dataset.close).close(); }; });
all("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => { if (state.busy || state.audio || state.audioStarting) event.preventDefault(); });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog || state.busy || state.audio || state.audioStarting) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});

function activeSpace() {
  return state.session?.controls?.find((control) => String(control.id) === String(state.session.activeControlId))?.name || "Meu espaço";
}
function wallets(selected, first = "Sem carteira") {
  return '<option value="">' + first + "</option>" + (state.data?.wallets || []).map((wallet) =>
    '<option value="' + escape(wallet.id) + '"' + (String(selected || "") === String(wallet.id) ? " selected" : "") + ">" + escape(wallet.name) + "</option>").join("");
}
function renderSession() {
  $("user-name").textContent = state.session?.user?.name || "";
  $("control-select").innerHTML = (state.session?.controls || []).map((control) => '<option value="' + escape(control.id) + '">' + escape(control.name) + "</option>").join("");
  $("control-select").value = state.session?.activeControlId || "";
  $("profile-name").value = state.session?.user?.name || "";
  $("profile-email").value = state.session?.user?.email || "";
  $("control-name").value = activeSpace();
}
function render(data) {
  if (!data?.summary) throw new Error("Não foi possível carregar seus números.");
  state.data = data;
  $("workspace-error").hidden = true;
  all("[data-panel]").forEach((panel) => { panel.inert = false; });
  if (data.session?.user) { state.session = data.session; renderSession(); }
  const validIds = new Set(data.transactions.map((item) => String(item.id)));
  state.selected = new Set([...state.selected].filter((id) => validIds.has(id)));
  const now = new Date();
  const month = localDate(now).slice(0, 7);
  const totals = settledTotals(data.transactions, month);
  $("today-label").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(now);
  $("month-label").textContent = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(now);
  $("report-month").textContent = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(now);
  $("income").textContent = money(totals.income);
  $("expenses").textContent = money(totals.expenses);
  $("result").textContent = money(totals.result);
  $("result").className = totals.result < 0 ? "expense" : "income";
  const pending = data.pendingTransactions || [];
  $("review-notice").hidden = !pending.length;
  $("review-count").textContent = pending.length + (pending.length === 1 ? " item para revisar" : " itens para revisar");
  $("chat-pending-count").hidden = !pending.length;
  $("chat-pending-count").textContent = pending.length;
  const bills = data.transactions.filter((item) => item.status === "scheduled").sort((a, b) => (a.dueDate || a.transactionDate).localeCompare(b.dueDate || b.transactionDate));
  $("home-bills").innerHTML = bills.slice(0, 3).map((item) => transactionRow(item, true)).join("") || '<p class="empty">' + icon("circle-check") + "Nenhuma conta em aberto.</p>";
  const recentGroups = groupDrafts(data.transactions.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  $("recent-transactions").innerHTML = recentGroups.slice(0, 4).map((group) => transactionRow({ ...group[0], seriesCount: group.length })).join("") || '<div class="empty">' + icon("receipt-text") + '<p>Seu primeiro lançamento começa aqui.</p><button type="button" class="text-button" data-register>Registrar agora</button></div>';
  $("pending-transactions").innerHTML = groupDrafts(pending).map((group) => '<button class="item-row" type="button" data-drafts="' + escape(group.map((item) => item.id).join(",")) + '">' + '<span class="row-symbol review">' + icon("clipboard-check") + '</span><span class="item-main"><strong>' + escape(group[0].description) + '</strong><small>' + (group.length > 1 ? group.length + " meses · " : "") + escape(group[0].category) + ' · Ainda não salvo</small></span><span class="item-end"><strong>' + money(group[0].amount) + (group.length > 1 ? "/mês" : "") + "</strong>" + icon("chevron-right") + "</span></button>").join("") || '<p class="empty">' + icon("circle-check") + "Tudo revisado.</p>";
  renderLedger();
  renderBills();
  renderMessages();
  renderReports();
  renderDocuments();
  renderWallets();
  icons();
}

function transactionRow(item, due = false, selection = false) {
  const open = item.status === "scheduled";
  const overdue = open && (item.dueDate || item.transactionDate) < localDate();
  const status = open ? (overdue ? "Atrasada" : item.kind === "income" ? "A receber" : "A pagar") : item.kind === "income" ? "Recebido" : "Pago";
  return '<button type="button" class="item-row" data-transaction="' + escape(item.id) + '"' + (selection ? ' aria-pressed="' + state.selected.has(String(item.id)) + '"' : "") + ">" +
    '<span class="row-symbol ' + (selection ? "selection" : item.kind) + '">' + icon(selection ? state.selected.has(String(item.id)) ? "square-check" : "square" : item.kind === "income" ? "arrow-down-left" : open ? "calendar-days" : "arrow-up-right") + "</span>" +
    '<span class="item-main"><strong>' + escape(item.description) + '</strong><small>' + (due ? date(item.dueDate || item.transactionDate) : escape(item.category) + " · " + date(item.transactionDate)) + (item.accountName ? " · " + escape(item.accountName) : "") + (item.seriesCount > 1 ? " · " + item.seriesCount + " meses" : "") + '</small></span><span class="item-end"><strong class="' + item.kind + '">' + (item.kind === "income" ? "+" : "−") + money(item.amount) + '</strong><small class="' + (overdue ? "danger" : "") + '">' + status + "</small></span></button>";
}
function renderLedger() {
  const items = filterLedger(state.data.transactions, state.filters);
  $("ledger-summary").textContent = items.length + " lançamentos · " + (state.filters.period === "all" ? "Todo o histórico" : state.filters.period === "previous-month" ? "Mês anterior" : "Mês atual");
  $("transactions").innerHTML = items.slice(0, state.ledgerLimit).map((item) => transactionRow(item, false, state.selecting)).join("") || '<p class="empty">Nenhum lançamento neste filtro.</p>';
  if (items.length > state.ledgerLimit) $("transactions").insertAdjacentHTML("beforeend", '<button type="button" class="text-button" data-more="ledger">Mostrar mais lançamentos</button>');
  $("selection-toggle").textContent = state.selecting ? "Concluir" : "Selecionar";
  $("selection-bar").hidden = !state.selecting;
  $("selection-count").textContent = state.selected.size + " selecionados";
  $("bulk-edit").disabled = !state.selected.size;
  const selectedWallet = $("ledger-wallet").value;
  $("ledger-wallet").innerHTML = wallets(selectedWallet, "Todas");
  $("ledger-wallet").value = state.filters.wallet;
  icons();
}
function renderBills() {
  const paid = state.billFilter === "paid";
  const items = state.data.transactions.filter((item) => paid ? item.status === "paid" : item.status === "scheduled").sort((a, b) => paid ? b.transactionDate.localeCompare(a.transactionDate) : (a.dueDate || a.transactionDate).localeCompare(b.dueDate || b.transactionDate));
  const payable = items.filter((item) => item.kind === "expense").reduce((sum, item) => sum + Number(item.amount), 0);
  const receivable = items.filter((item) => item.kind === "income").reduce((sum, item) => sum + Number(item.amount), 0);
  $("bills-summary").textContent = paid ? items.length + " contas liquidadas" : money(payable) + " a pagar" + (receivable ? " · " + money(receivable) + " a receber" : "");
  $("bills").innerHTML = items.map((item) => transactionRow(item, true)).join("") || '<p class="empty">' + icon("calendar-check") + (paid ? "Nenhuma conta liquidada por aqui." : "Nenhuma conta em aberto.") + "</p>";
}
function renderMessages() {
  const wasNearEnd = $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 100;
  const messages = state.data.messages || [];
  $("messages").innerHTML = (messages.length > state.messageLimit ? '<button type="button" class="text-button" data-more="messages">Ver mensagens anteriores</button>' : "") + messages.slice(-state.messageLimit).map((message) => {
    const ids = state.chatDrafts.get(String(message.id)) || [];
    const current = captureDrafts(state.data, ids);
    return '<article class="message ' + (message.role === "user" ? "user" : "assistant") + '"><p>' + escape(message.content) + "</p>" +
      (current.length ? '<button class="text-button" type="button" data-drafts="' + escape(current.map((item) => item.id).join(",")) + '">' + icon("clipboard-check") + "Conferir " + current.length + (current.length === 1 ? " lançamento" : " lançamentos") + "</button>" : "") + "</article>";
  }).join("");
  if (wasNearEnd) $("messages").scrollTop = $("messages").scrollHeight;
}
function renderReports() {
  const transactions = state.data.transactions;
  const series = (state.data.summary.monthlySeries || []).map((period) => ({ ...period, ...settledTotals(transactions, period.key || period.month) }));
  const max = Math.max(1, ...series.flatMap((period) => [period.income, period.expenses]));
  const current = series.at(-1);
  const previous = series.at(-2);
  $("insights").innerHTML = '<section class="report-section"><h2>Entradas e saídas</h2><div class="chart-legend"><span class="income">Entradas</span><span class="expense">Saídas</span></div><div class="monthly-chart" role="img" aria-label="Receitas e despesas realizadas por mês">' + series.map((period) =>
    '<div><div class="chart-bars"><span class="income-bar" style="height:' + Math.max(2, period.income / max * 100) + '%" title="' + escape(money(period.income)) + '"></span><span class="expense-bar" style="height:' + Math.max(2, period.expenses / max * 100) + '%" title="' + escape(money(period.expenses)) + '"></span></div><small>' + escape(period.shortLabel || period.month?.slice(5) || period.label) + "</small></div>").join("") + '</div></section>' +
    (current && previous ? '<section class="report-section"><h2>Comparação com o mês anterior</h2><div class="report-line"><span>Entradas</span><strong>' + money(current.income - previous.income) + '</strong></div><div class="report-line"><span>Saídas</span><strong>' + money(current.expenses - previous.expenses) + "</strong></div></section>" : "");
  const totals = new Map();
  transactions.filter((item) => item.kind === state.category && item.status !== "scheduled" && item.transactionDate.startsWith(localDate().slice(0, 7))).forEach((item) => totals.set(item.category, (totals.get(item.category) || 0) + Number(item.amount)));
  $("categories").innerHTML = [...totals].sort((a, b) => b[1] - a[1]).map(([name, amount]) => '<button type="button" class="item-row" data-category-filter="' + escape(name) + '"><span class="item-main"><strong>' + escape(name) + '</strong></span><strong>' + money(amount) + "</strong>" + icon("chevron-right") + "</button>").join("") || '<p class="empty">Sem lançamentos realizados neste mês.</p>';
}
function renderDocuments() {
  const labels = { ocr_pending: "Arquivo recebido", review_pending: "Leitura concluída", failed: "Não foi possível ler", processed: "Concluído" };
  const documents = state.data.documents || [];
  $("documents").innerHTML = documents.slice(0, state.documentLimit).map((document) => '<a class="item-row" href="/api/documents/' + encodeURIComponent(document.id) + '/view" target="_blank" rel="noopener"><span class="row-symbol">' + icon("file-text") + '</span><span class="item-main"><strong>' + escape(document.originalName) + '</strong><small>' + (labels[document.status] || "Recebido") + " · " + date(document.createdAt) + '</small></span>' + icon("external-link") + "</a>").join("") || '<p class="empty">Nenhum comprovante enviado.</p>';
  if (documents.length > state.documentLimit) $("documents").insertAdjacentHTML("beforeend", '<button type="button" class="text-button" data-more="documents">Mostrar mais comprovantes</button>');
}
function renderWallets() {
  const types = { checking: "Conta corrente", cash: "Dinheiro", savings: "Poupança", credit_card: "Cartão de crédito", investment: "Investimento" };
  $("wallet-list").innerHTML = (state.data.wallets || []).map((wallet) => '<form class="wallet-editor settings-form" data-wallet="' + escape(wallet.id) + '"><label><span>Nome</span><input name="name" required value="' + escape(wallet.name) + '" /></label><div class="form-grid"><label><span>Tipo</span><select name="type">' + Object.entries(types).map(([value, label]) => '<option value="' + value + '"' + (value === wallet.type ? " selected" : "") + ">" + label + "</option>").join("") + '</select></label><label><span>Saldo inicial</span><input name="openingBalance" inputmode="decimal" value="' + Number(wallet.openingBalance || 0).toFixed(2).replace(".", ",") + '" /></label></div><p class="list-caption">Saldo realizado: ' + money(wallet.balance) + '</p><div class="sheet-actions"><button type="button" class="danger" data-remove-wallet="' + escape(wallet.id) + '">Remover</button><button type="submit">Salvar carteira</button></div></form>').join("");
}

document.addEventListener("click", (event) => {
  const more = event.target.closest("[data-more]");
  if (more) {
    if (more.dataset.more === "ledger") { state.ledgerLimit += 50; renderLedger(); }
    if (more.dataset.more === "documents") { state.documentLimit += 50; renderDocuments(); }
    if (more.dataset.more === "messages") { state.messageLimit += 60; renderMessages(); }
    icons();
  }
  const transaction = event.target.closest("[data-transaction]");
  const drafts = event.target.closest("[data-drafts]");
  const category = event.target.closest("[data-category-filter]");
  if (transaction) {
    if (state.busy) return;
    const id = transaction.dataset.transaction;
    if (state.selecting && state.panel === "ledger") {
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderLedger();
    } else openDetail(id);
  }
  if (drafts) showCapture(drafts.dataset.drafts.split(","));
  if (category) {
    state.filters.category = category.dataset.categoryFilter; state.filters.kind = state.category;
    state.filters.period = "current-month"; syncFilters(); renderLedger(); openPanel("ledger");
  }
  if (event.target.closest("[data-register]")) openCapture();
});
all("[data-dashboard-filter]").forEach((button) => { button.onclick = () => {
  state.filters = { kind: button.dataset.dashboardFilter, period: "current-month", category: "", wallet: "", search: "" };
  syncFilters(); renderLedger(); openPanel("ledger");
}; });
all("[data-bill-filter]").forEach((button) => { button.onclick = () => {
  state.billFilter = button.dataset.billFilter;
  all("[data-bill-filter]").forEach((tab) => { tab.classList.toggle("active", tab === button); tab.setAttribute("aria-pressed", tab === button); });
  renderBills(); icons();
}; });
all("[data-category]").forEach((button) => { button.onclick = () => {
  state.category = button.dataset.category;
  all("[data-category]").forEach((tab) => tab.classList.toggle("active", tab === button));
  renderReports(); icons();
}; });
$("filter-toggle").onclick = () => { $("ledger-filters").hidden = !$("ledger-filters").hidden; $("filter-toggle").setAttribute("aria-expanded", !$("ledger-filters").hidden); };
function syncFilters() { ["kind", "period", "category", "wallet", "search"].forEach((key) => { $("ledger-" + key).value = state.filters[key]; }); }
["kind", "period", "category", "wallet", "search"].forEach((key) => { $("ledger-" + key).addEventListener("input", () => { state.filters[key] = $("ledger-" + key).value; state.ledgerLimit = 50; renderLedger(); }); });
$("clear-filters").onclick = () => { state.filters = { kind: "all", period: "current-month", category: "", wallet: "", search: "" }; syncFilters(); renderLedger(); };
$("selection-toggle").onclick = () => { state.selecting = !state.selecting; state.selected.clear(); renderLedger(); };
$("bulk-edit").onclick = () => openBulk();

function openCapture() {
  if (!state.data) { toast("Carregue o espaço financeiro antes de registrar."); return; }
  if (state.busy || state.audio || state.audioStarting) return;
  if (captureDrafts(state.data, state.captureIds).length) { showCapture(state.captureIds); return; }
  state.captureIds = [];
  $("capture-title").textContent = "Registrar";
  $("capture-space").textContent = activeSpace();
  $("capture-entry").hidden = false;
  $("capture-result").hidden = true;
  $("capture-error").hidden = true;
  $("capture-progress").hidden = true;
  $("manual-form").elements.transactionDate.value ||= localDate();
  $("manual-form").elements.accountId.innerHTML = wallets($("manual-form").elements.accountId.value);
  openSheet("capture-dialog");
}
$("register-button").onclick = openCapture;
$("capture-dialog").addEventListener("close", () => { state.captureIds = []; });
$("manual-toggle").onclick = () => {
  $("manual-form").hidden = !$("manual-form").hidden;
  $("capture-text-form").hidden = !$("manual-form").hidden;
  if (!$("manual-form").hidden) $("manual-form").elements.amount.focus();
};
$("manual-form").elements.paymentState.onchange = () => { $("manual-date-label").textContent = $("manual-form").elements.paymentState.value === "scheduled" ? "Vencimento" : "Data"; };
function captureProgress(text) {
  $("capture-entry").hidden = true; $("capture-result").hidden = true;
  $("capture-progress").hidden = false; $("capture-progress-text").textContent = text;
  $("capture-error").hidden = true;
}
async function captureRequest(url, body, progress, multipart = false) {
  openCapture();
  await task(async () => {
    captureProgress(progress);
    try {
      const data = await request(url, body, multipart);
      const ids = data.capture?.transactionIds || [];
      const last = data.messages?.at(-1);
      if (last?.role === "assistant" && ids.length) state.chatDrafts.set(String(last.id), ids);
      render(data);
      if (ids.length) {
        if (url === "/api/chat") $("capture-text").value = "";
        showCapture(ids);
      } else {
        $("capture-entry").hidden = false;
        const message = data.messages?.at(-1)?.content || "Não encontrei um lançamento. Informe o valor e a descrição, ou use o registro manual.";
        feedback("capture-error", message);
      }
    } finally { $("capture-progress").hidden = true; }
  }, "capture-error");
  if (!state.captureIds.length) $("capture-entry").hidden = false;
}
$("capture-text-form").onsubmit = (event) => {
  event.preventDefault();
  const message = $("capture-text").value.trim();
  if (message) captureRequest("/api/chat", { message }, "Entendendo seu lançamento…");
};
$("manual-form").onsubmit = (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  body.dueDate = body.paymentState === "scheduled" ? body.transactionDate : null;
  captureRequest("/api/transactions", body, "Preparando a conferência…");
};
all("[data-capture]").forEach((button) => { button.onclick = () => {
  if (state.busy || state.audio) return;
  if (captureDrafts(state.data, state.captureIds).length) { showCapture(state.captureIds); return; }
  (button.dataset.capture === "camera" ? $("camera-input") : $("file-input")).click();
}; });
["file-input", "camera-input"].forEach((id) => { $(id).onchange = async () => {
  const file = $(id).files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast("Escolha um arquivo de até 20 MB."); $(id).value = ""; return; }
  const body = new FormData(); body.append("file", file);
  await captureRequest("/api/upload", body, "Enviando e lendo o comprovante…", true);
  $(id).value = "";
}; });
function showCapture(ids) {
  state.captureIds = ids.map(String);
  const drafts = captureDrafts(state.data, state.captureIds);
  if (!drafts.length) { $("capture-dialog").close(); state.captureIds = []; return; }
  $("capture-title").textContent = drafts.length > 1 ? "Conferir lançamentos" : "Conferir lançamento";
  $("capture-space").textContent = activeSpace();
  $("capture-entry").hidden = true; $("capture-progress").hidden = true;
  $("capture-result").hidden = false; $("capture-error").hidden = true;
  const groups = groupDrafts(drafts);
  $("capture-edit").hidden = groups.length > 1;
  $("capture-preview").innerHTML = groups.map((group) => {
    const item = group[0];
    const unpaid = group.filter((entry) => entry.dueDate).length;
    const paymentLabel = group.length > 1 && unpaid > 0 && unpaid < group.length
      ? "Primeiro realizado · Próximos em aberto"
      : item.dueDate ? (item.kind === "income" ? "A receber" : "A pagar") : (item.kind === "income" ? "Recebida" : "Paga");
    const sameAmount = new Set(group.map((entry) => Number(entry.amount))).size === 1;
    const sameWallet = new Set(group.map((entry) => entry.accountId || "")).size === 1;
    const walletName = sameWallet ? item.accountName || state.data.wallets?.find((wallet) => String(wallet.id) === String(item.accountId))?.name || "Sem carteira" : "Carteiras diferentes";
    const amount = sameAmount ? item.amount : group.reduce((sum, entry) => sum + Number(entry.amount), 0);
    return '<article class="capture-card"><span class="eyebrow">' +
      (item.kind === "income" ? "Receita" : "Despesa") + " · " + paymentLabel +
      '</span><h2>' + escape(item.description) + '</h2><strong class="capture-value">' +
      money(amount) + (group.length > 1 ? '<small>' + (sameAmount ? " por mês" : " no total · valores variáveis") + "</small>" : "") +
      '</strong><dl><div><dt>' + (item.dueDate ? "Vencimento" : "Data") + '</dt><dd>' +
      date(item.dueDate || item.transactionDate) + '</dd></div><div><dt>Categoria</dt><dd>' +
      escape(item.category) + '</dd></div><div><dt>Carteira</dt><dd>' + escape(walletName) +
      '</dd></div>' + (group.length > 1 ? '<div><dt>Repetição</dt><dd>' + group.length +
      " meses, até " + date(group.at(-1).dueDate || group.at(-1).transactionDate) + '</dd></div>' : "") +
      '</dl>' + (groups.length > 1 ? '<button type="button" class="text-button" data-transaction="' +
      escape(item.id) + '">' + icon("pencil") + "Editar dados</button>" : "") + "</article>";
  }).join("");
  $("capture-result-note").textContent = drafts.length > 1 ? "Serão salvos " + drafts.length + " lançamentos desta captura. Total: " + money(drafts.reduce((sum, item) => sum + Number(item.amount), 0)) + "." : "O lançamento só entra nos seus totais ao salvar.";
  $("capture-save").innerHTML = icon("check") + (drafts.length > 1 ? "Salvar " + drafts.length + " lançamentos" : "Salvar lançamento");
  $("capture-edit").onclick = () => drafts.length > 1 && drafts[0].recurrenceGroupId ? openBulk(drafts[0]) : openDetail(drafts[0].id);
  openSheet("capture-dialog");
}
$("capture-save").onclick = () => task(async () => {
  const drafts = captureDrafts(state.data, state.captureIds);
  for (const item of drafts) render(await request("/api/transactions/" + encodeURIComponent(item.id) + "/confirm", {}));
  state.captureIds = [];
  $("capture-dialog").close();
  $("manual-form").reset(); $("manual-form").hidden = true; $("capture-text-form").hidden = false;
  toast(drafts.length === 1 ? "Lançamento salvo." : drafts.length + " lançamentos salvos.", async () => {
    for (const item of drafts) render(await request("/api/transactions/" + encodeURIComponent(item.id) + "/remove", {}));
    toast("Registro desfeito.");
  });
}, "capture-error");
$("capture-discard").onclick = () => task(async () => {
  const drafts = captureDrafts(state.data, state.captureIds);
  for (const item of drafts) render(await request("/api/transactions/" + encodeURIComponent(item.id) + "/dismiss", {}));
  state.captureIds = []; $("capture-dialog").close(); toast("Captura descartada.", async () => {
    for (const item of drafts) render(await request("/api/transactions/" + encodeURIComponent(item.id) + "/restore", { status: "pending" }));
    toast("Rascunhos recuperados em Para revisar.");
  });
}, "capture-error");

function findTransaction(id) { return [...state.data.transactions, ...state.data.pendingTransactions].find((item) => String(item.id) === String(id)); }
function openDetail(id) {
  const item = findTransaction(id); if (!item) return;
  state.detailId = String(id); $("detail-error").hidden = true;
  const scheduled = item.status === "scheduled" || (item.status === "pending" && item.dueDate);
  $("detail-title").textContent = item.status === "pending" ? "Editar rascunho" : "Editar lançamento";
  $("detail-body").innerHTML = '<form id="detail-form" class="settings-form"><label><span>Descrição</span><input name="description" value="' + escape(item.description) + '" required /></label><div class="form-grid"><label><span>Valor (R$)</span><input name="amount" inputmode="decimal" value="' + Number(item.amount).toFixed(2).replace(".", ",") + '" required /></label><label><span>Tipo</span><select name="kind"><option value="expense"' + (item.kind === "expense" ? " selected" : "") + '>Despesa</option><option value="income"' + (item.kind === "income" ? " selected" : "") + '>Receita</option></select></label></div><div class="form-grid"><label><span>Situação</span><select name="paymentState"><option value="settled"' + (!scheduled ? " selected" : "") + '>Já pago / recebido</option><option value="scheduled"' + (scheduled ? " selected" : "") + '>A pagar / receber</option></select></label><label><span>Data do lançamento</span><input type="date" name="transactionDate" value="' + escape(item.transactionDate) + '" required /></label></div><label id="detail-due"><span>Vencimento</span><input type="date" name="dueDate" value="' + escape(item.dueDate || item.transactionDate) + '" /></label><div class="form-grid"><label><span>Categoria</span><input name="category" list="category-options" value="' + escape(item.category) + '" /></label><label><span>Carteira</span><select name="accountId">' + wallets(item.accountId) + '</select></label></div><label><span>Forma de pagamento</span><input name="paymentMethod" value="' + escape(item.paymentMethod || "") + '" placeholder="Pix, cartão, dinheiro…" /></label>' + (item.recurrenceGroupId ? '<button type="button" class="notice-row" id="detail-series">' + icon("repeat-2") + '<span>Alterar valor ou carteira da série</span>' + icon("chevron-right") + '</button>' : "") +
    '<button type="submit" class="primary">' + icon("check") + 'Salvar edição</button></form>' +
    (item.status === "scheduled" ? '<form id="payment-form" class="settings-form payment-form"><label><span>Data do ' + (item.kind === "income" ? "recebimento" : "pagamento") + '</span><input name="transactionDate" type="date" required value="' + localDate() + '" /></label><button class="primary" type="submit">' + icon("circle-check") + (item.kind === "income" ? "Registrar recebimento" : "Registrar pagamento") + "</button></form>" : "") +
    '<button type="button" class="text-button danger" id="remove-transaction">' + icon("trash-2") + (item.status === "pending" ? "Descartar rascunho" : "Remover lançamento") + "</button>";
  const form = $("detail-form");
  if (item.status !== "pending") {
    $("detail-title").textContent = "Detalhes";
    form.hidden = true;
    form.insertAdjacentHTML("beforebegin", '<section id="detail-summary"><p class="eyebrow">' + escape(item.category) + '</p><h2>' + escape(item.description) + '</h2><strong class="capture-value ' + item.kind + '">' + money(item.amount) + '</strong><p class="list-caption">' + date(item.dueDate || item.transactionDate) + " · " + escape(item.accountName || "Sem carteira") + '</p><button id="detail-edit-button" class="text-button" type="button">' + icon("pencil") + 'Editar dados</button></section>');
    $("detail-edit-button").onclick = () => {
      form.hidden = false; $("detail-summary").hidden = true;
      $("detail-title").textContent = "Editar lançamento";
      if ($("payment-form")) $("payment-form").hidden = true;
    };
  }
  const updateDue = () => { $("detail-due").hidden = form.elements.paymentState.value !== "scheduled"; form.elements.dueDate.required = !$("detail-due").hidden; };
  form.elements.paymentState.onchange = updateDue; updateDue();
  form.onsubmit = (event) => {
    event.preventDefault();
    task(async () => {
      const body = Object.fromEntries(new FormData(form));
      if (body.paymentState !== "scheduled") body.dueDate = null;
      render(await request("/api/transactions/" + encodeURIComponent(id) + "/update", body));
      $("detail-dialog").close();
      if ($("capture-dialog").open) showCapture(state.captureIds);
      toast("Lançamento atualizado.");
    }, "detail-error");
  };
  if ($("detail-series")) $("detail-series").onclick = () => openBulk(item);
  if ($("payment-form")) $("payment-form").onsubmit = (event) => {
    event.preventDefault();
    task(async () => {
      render(await request("/api/transactions/" + encodeURIComponent(id) + "/paid", Object.fromEntries(new FormData(event.currentTarget))));
      $("detail-dialog").close(); toast(item.kind === "income" ? "Recebimento registrado." : "Pagamento registrado.");
    }, "detail-error");
  };
  $("remove-transaction").onclick = () => task(async () => {
    render(await request("/api/transactions/" + encodeURIComponent(id) + "/remove", {}));
    $("detail-dialog").close();
    if ($("capture-dialog").open) showCapture(state.captureIds);
    toast("Lançamento removido.", async () => { render(await request("/api/transactions/" + encodeURIComponent(id) + "/restore", { status: item.status })); toast("Lançamento recuperado."); });
  }, "detail-error");
  openSheet("detail-dialog");
}
function bulkTargets() {
  const items = [...state.data.transactions, ...state.data.pendingTransactions];
  return state.bulkAnchor ? seriesTargets(items, state.bulkAnchor, $("bulk-form").elements.scope.value) : items.filter((item) => state.selected.has(String(item.id)));
}
function openBulk(anchor = null) {
  state.bulkAnchor = anchor;
  $("bulk-form").reset(); $("bulk-error").hidden = true;
  $("bulk-form").elements.accountId.innerHTML = '<option value="__keep">Manter carteira atual</option>' + wallets("", "Sem carteira");
  $("bulk-scope-label").hidden = !anchor?.recurrenceGroupId;
  $("bulk-caption").textContent = anchor ? anchor.description : "Lançamentos selecionados";
  $("bulk-form").elements.scope.value = anchor?.status === "pending" ? "all" : "one";
  previewBulk(); openSheet("bulk-dialog");
}
function previewBulk() { $("bulk-preview").textContent = bulkTargets().length + " lançamento(s) serão alterados. Datas e situação serão mantidas."; }
$("bulk-form").elements.scope.onchange = previewBulk;
$("bulk-form").onsubmit = (event) => {
  event.preventDefault();
  task(async () => {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const ids = bulkTargets().map((item) => item.id);
    if (ids.length > 100) throw new Error("Selecione no máximo 100 lançamentos por vez.");
    const changes = { ids };
    if (body.amount.trim()) changes.amount = body.amount;
    if (body.accountId !== "__keep") changes.accountId = body.accountId || null;
    if (!changes.amount && changes.accountId === undefined) throw new Error("Informe um novo valor ou escolha uma carteira.");
    render(await request("/api/transactions/bulk-update", changes));
    $("bulk-dialog").close(); $("detail-dialog").close();
    if ($("capture-dialog").open) showCapture(state.captureIds);
    state.selected.clear(); state.selecting = false; renderLedger();
    toast(ids.length + " lançamentos atualizados.");
  }, "bulk-error");
};

$("chat-form").onsubmit = (event) => { event.preventDefault(); sendChat($("message-input").value.trim()); };
async function sendChat(message) {
  if (!message) return;
  await task(async () => {
    $("message-input").setAttribute("aria-busy", "true");
    $("messages").insertAdjacentHTML("beforeend", '<article id="chat-working" class="message assistant" role="status">' + icon("loader-circle") + " Consultando…</article>");
    icons(); $("messages").scrollTop = $("messages").scrollHeight;
    try {
      const data = await request("/api/chat", { message });
      const ids = data.capture?.transactionIds || [];
      if (ids.length) state.chatDrafts.set(String(data.messages.at(-1).id), ids);
      render(data); $("message-input").value = "";
      $("messages").scrollTop = $("messages").scrollHeight;
      if (ids.length) showCapture(ids);
    } finally { $("message-input").removeAttribute("aria-busy"); $("chat-working")?.remove(); }
  });
}
all("[data-question]").forEach((button) => { button.onclick = () => sendChat(button.dataset.question); });

all("[data-audio]").forEach((button) => { button.onclick = () => startAudio(button.dataset.audio); });
async function startAudio(origin) {
  if (state.busy || state.audio || state.audioStarting) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { toast("Gravação indisponível neste navegador. Você pode escrever ou usar o registro manual."); return; }
  const requestId = ++audioRequest;
  state.audioStarting = true;
  all("[data-audio]").forEach((button) => { button.disabled = true; });
  $("control-select").disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (requestId !== audioRequest) { stream.getTracks().forEach((track) => track.stop()); return; }
    state.audioStarting = false;
    state.stream = stream;
    const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    state.audio = mimeType ? new MediaRecorder(state.stream, { mimeType }) : new MediaRecorder(state.stream);
    state.chunks = []; state.audioOrigin = origin;
    state.audio.addEventListener("dataavailable", (event) => { if (event.data.size) state.chunks.push(event.data); });
    state.audio.addEventListener("stop", finishAudio, { once: true });
    state.audio.addEventListener("error", () => { cancelAudio(); toast("A gravação foi interrompida. Você pode tentar novamente ou escrever."); }, { once: true });
    state.audio.start(250);
    const started = Date.now();
    $("audio-bar").hidden = false; $("audio-status").textContent = "Gravando · 00:00";
    if ($("capture-dialog").open) $("capture-dialog").append($("audio-bar"));
    all("[data-audio]").forEach((button) => { button.disabled = true; });
    state.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      $("audio-status").textContent = "Gravando · 00:" + String(seconds).padStart(2, "0");
      if (seconds >= 60) state.audio?.stop();
    }, 500);
  } catch (error) { releaseAudio(); toast(error.name === "NotAllowedError" ? "Microfone não autorizado. Você ainda pode escrever ou anexar um comprovante." : "Não consegui iniciar a gravação."); }
}
$("audio-stop").onclick = () => { if (state.audio?.state === "recording") state.audio.stop(); };
$("audio-cancel").onclick = cancelAudio;
function releaseAudio() {
  clearInterval(state.timer); state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null; state.audio = null; state.chunks = []; state.audioStarting = false;
  $("control-select").disabled = state.busy;
  $("audio-bar").hidden = true; document.body.append($("audio-bar"));
  all("[data-audio]").forEach((button) => { button.disabled = false; });
}
function cancelAudio() {
  audioRequest++;
  if (state.audio) { state.audio.removeEventListener("stop", finishAudio); if (state.audio.state !== "inactive") state.audio.stop(); }
  releaseAudio();
}
async function finishAudio() {
  const mime = state.audio?.mimeType || "audio/webm";
  const blob = new Blob(state.chunks, { type: mime });
  releaseAudio();
  if (!blob.size) { toast("O áudio ficou vazio. Tente novamente ou escreva a mensagem."); return; }
  const body = new FormData();
  body.append("audio", blob, "mensagem." + (mime.includes("mp4") ? "m4a" : "webm"));
  await captureRequest("/api/audio", body, "Transcrevendo e entendendo seu áudio…", true);
}
document.addEventListener("visibilitychange", () => { if (document.hidden && (state.audio || state.audioStarting)) cancelAudio(); });

$("control-select").onchange = () => task(async () => {
  cancelAudio(); state.captureIds = []; state.selected.clear(); state.chatDrafts.clear();
  state.session = await request("/api/controls/select", { controlId: $("control-select").value }).catch((error) => {
    $("control-select").value = state.session.activeControlId;
    throw error;
  });
  renderSession();
  await loadActiveState(); openPanel("home");
});
async function loadActiveState() {
  try { render(await request("/api/state")); }
  catch (error) {
    state.data = null;
    all("[data-panel]").forEach((panel) => { panel.inert = true; });
    $("workspace-error").hidden = false;
    throw error;
  }
}
$("reload-space").onclick = () => task(async () => {
  state.session = await request("/api/session");
  render(await request("/api/state")); renderSession(); openPanel("home");
});
function settingsForm(id, url, message, sessionResponse = false) {
  $(id).onsubmit = (event) => {
    event.preventDefault();
    task(async () => {
      const data = await request(url, Object.fromEntries(new FormData(event.currentTarget)));
      if (sessionResponse) {
        state.session = data; renderSession();
        if (id === "new-control-form") { state.captureIds = []; state.selected.clear(); state.chatDrafts.clear(); await loadActiveState(); }
      }
      else if (data.summary) render(data);
      else if (id === "password-form") $(id).reset();
      feedback("settings-feedback", message);
    }, "settings-feedback");
  };
}
settingsForm("profile-form", "/api/settings/profile", "Perfil atualizado.", true);
settingsForm("control-settings-form", "/api/settings/control", "Espaço atualizado.", true);
settingsForm("new-control-form", "/api/controls", "Espaço criado.", true);
settingsForm("share-form", "/api/controls/share", "Acesso concedido.", true);
settingsForm("password-form", "/api/settings/password", "Senha alterada.");
settingsForm("wallet-form", "/api/settings/wallets", "Carteira adicionada.");
$("wallet-list").addEventListener("submit", (event) => {
  event.preventDefault(); const form = event.target.closest("[data-wallet]"); if (!form) return;
  task(async () => { render(await request("/api/settings/wallets/" + encodeURIComponent(form.dataset.wallet) + "/update", Object.fromEntries(new FormData(form)))); feedback("settings-feedback", "Carteira atualizada."); }, "settings-feedback");
});
$("wallet-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-wallet]");
  if (!button || !confirm("Remover esta carteira? Os lançamentos serão mantidos sem carteira.")) return;
  task(async () => { render(await request("/api/settings/wallets/" + encodeURIComponent(button.dataset.removeWallet) + "/remove", {})); feedback("settings-feedback", "Carteira removida."); }, "settings-feedback");
});
$("logout-button").onclick = () => task(async () => { cancelAudio(); await request("/api/auth/logout", {}); state.data = null; state.session = null; state.captureIds = []; state.chatDrafts.clear(); showAuth(); });

function showAuth() {
  $("app-shell").hidden = true; $("auth-screen").hidden = false;
  all("dialog[open]").forEach((dialog) => dialog.close()); setAuthMode(state.authMode);
}
function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === "register", forgot = mode === "forgot", reset = mode === "reset";
  $("auth-name-field").hidden = !register; $("auth-name").required = register;
  $("auth-email-field").hidden = reset; $("auth-email").required = !reset;
  $("auth-password-field").hidden = forgot; $("auth-password").required = !forgot;
  $("auth-password").autocomplete = register || reset ? "new-password" : "current-password";
  $("auth-remember-field").hidden = mode !== "login";
  $("auth-submit").textContent = register ? "Criar conta" : forgot ? "Enviar link de recuperação" : reset ? "Salvar nova senha" : "Entrar";
  $("auth-subtitle").textContent = register ? "Criar sua conta" : forgot ? "Recuperar acesso" : reset ? "Definir nova senha" : "Entrar na conta";
  $("auth-register").hidden = forgot || reset; $("auth-register").textContent = register ? "Já tenho conta" : "Criar conta";
  $("forgot-password-button").hidden = mode !== "login"; $("back-login-button").hidden = !forgot && !reset;
  $("auth-error").hidden = true; $("auth-help").hidden = true;
}
$("auth-register").onclick = () => setAuthMode(state.authMode === "register" ? "login" : "register");
$("forgot-password-button").onclick = () => setAuthMode("forgot");
$("back-login-button").onclick = () => { history.replaceState(null, "", location.pathname); setAuthMode("login"); };
$("auth-form").onsubmit = (event) => {
  event.preventDefault();
  task(async () => {
    const mode = state.authMode;
    const body = { name: $("auth-name").value.trim(), email: $("auth-email").value.trim(), password: $("auth-password").value, remember: $("auth-remember").checked };
    if (mode === "forgot") { await request("/api/auth/forgot", body); feedback("auth-help", "Se este e-mail estiver cadastrado, enviaremos um link para redefinir sua senha."); return; }
    if (mode === "reset") {
      await request("/api/auth/reset", { token: new URLSearchParams(location.search).get("reset"), password: body.password });
      history.replaceState(null, "", location.pathname); setAuthMode("login"); $("auth-password").value = ""; feedback("auth-help", "Senha alterada. Entre com sua nova senha."); return;
    }
    state.session = await request("/api/auth/" + mode, body);
    $("auth-password").value = ""; renderSession(); render(await request("/api/state"));
    $("auth-screen").hidden = true; $("app-shell").hidden = false; openPanel("home");
  }, "auth-error");
};
window.addEventListener("offline", () => toast("Você está sem conexão. O texto em edição será mantido nesta tela."));
window.addEventListener("online", () => toast("Conexão restabelecida."));
function fitViewport() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", height + "px");
}
window.visualViewport?.addEventListener("resize", fitViewport);
window.addEventListener("resize", fitViewport);
fitViewport();
async function init() {
  icons(); setAuthMode(state.authMode);
  try {
    state.session = await request("/api/session");
    if (!state.session.user || state.authMode === "reset") return;
    renderSession(); render(await request("/api/state"));
    $("auth-screen").hidden = true; $("app-shell").hidden = false;
  } catch (error) { feedback("auth-error", error.message, true); }
}
init();
