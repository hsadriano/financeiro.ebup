import { localDate, groupDrafts, captureDrafts, seriesTargets, moveTargets, filterLedger, settledTotals } from "/ui-model.js?v=20261118-3";
import { LocalCaptures, localContext, attemptBody, remainingDraft } from "/local-captures.js?v=20261118-2";

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
  detailId: null, bulkAnchor: null, moveIds: [], moveWallets: null, moveWalletRequest: 0, moveLoading: false,
  recurrenceAnchor: null, recurrencePlan: null, recurrenceAction: "reschedule", recurrenceLimit: 50,
  audio: null, stream: null, chunks: [], timer: null,
  ledgerLimit: 50, documentLimit: 50, messageLimit: 60,
  audioOrigin: "capture", chatDrafts: new Map(),
  authMode: new URLSearchParams(location.search).has("reset") ? "reset" : "login",
  filters: { kind: "all", period: "current-month", category: "", wallet: "", search: "" }
};
let toastTimer;
let toastUndo;
let audioRequest = 0;
const localCaptures = new LocalCaptures();
state.localKey = null;
state.localReady = Promise.resolve();
state.draftWrites = Promise.resolve();

async function request(url, body, multipart = false, attempt = null) {
  let response;
  const headers = multipart ? {} : { "Content-Type": "application/json" };
  if (attempt) {
    const [userId, controlId] = attempt.context.split(":").map(decodeURIComponent);
    Object.assign(headers, { "Idempotency-Key": attempt.id, "X-Finup-User-Id": userId, "X-Finup-Control-Id": controlId });
  }
  const controller = attempt ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 90000) : null;
  try {
    response = await fetch(url, body === undefined ? {} : {
      method: "POST", headers,
      body: multipart ? body : JSON.stringify(body), signal: controller?.signal
    });
  } catch {
    if (timer) clearTimeout(timer);
    throw Object.assign(new Error("Conexão interrompida. O envio não foi confirmado."), { retryable: true });
  }
  const data = await response.json()
    .catch(() => { throw Object.assign(new Error("Não recebi uma confirmação válida do servidor."), { retryable: true }); })
    .finally(() => { if (timer) clearTimeout(timer); });
  if (response.status === 401 && !url.includes("/auth/")) {
    showAuth();
    throw Object.assign(new Error("Sua sessão terminou. Entre novamente."), { retryable: true });
  }
  if (!response.ok) throw Object.assign(new Error(data.error === "Erro interno"
    ? "Não foi possível concluir agora. Seus dados já salvos continuam disponíveis."
    : data.error || "Não foi possível concluir. Tente novamente."), { retryable: response.status >= 500 || [401, 403, 408, 409, 429].includes(response.status), code: data.code, response: data });
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
    $("bulk-edit").disabled = !state.selected.size;
    $("move-selected").disabled = !state.selected.size;
    if ($("move-dialog").open) previewMove();
    if ($("capture-dialog").open && !$("capture-result").hidden) syncCaptureSave();
    if ($("recurrence-dialog").open) syncRecurrenceSubmit();
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
  if (name === "device") refreshLocalNotice();
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
all("[data-back]").forEach((button) => { button.onclick = () => openPanel(["pending", "files", "reports", "settings", "device"].includes(state.back) ? "home" : state.back); });
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
function editableMoveDestinations() {
  return (state.session?.controls || []).filter((control) => String(control.id) !== String(state.session?.activeControlId) && ["owner", "editor"].includes(control.role));
}
function canMoveBetweenControls() {
  const active = (state.session?.controls || []).find((control) => String(control.id) === String(state.session?.activeControlId));
  return Boolean(active && ["owner", "editor"].includes(active.role) && editableMoveDestinations().length);
}
function currentLocalContext() {
  return state.session?.user ? localContext(state.session.user.id, state.session.activeControlId) : null;
}
function draftSnapshot() {
  return {
    context: currentLocalContext(), updatedAt: Date.now(),
    text: $("capture-text").value, chatText: $("message-input").value,
    manual: Object.fromEntries(new FormData($("manual-form"))), manualOpen: !$("manual-form").hidden
  };
}
function hasDraft(draft) {
  return Boolean(draft && (draft.text?.trim() || draft.chatText?.trim() || draft.manual?.amount?.trim() || draft.manual?.description?.trim()));
}
async function activateLocalContext(context) {
  state.localKey = context;
  $("capture-text").value = ""; $("message-input").value = ""; $("manual-form").reset();
  $("manual-form").hidden = true; $("capture-text-form").hidden = false;
  $("draft-status").hidden = true;
  try {
    const draft = await localCaptures.draft(context);
    if (currentLocalContext() !== context) return;
    if (draft) {
      $("capture-text").value = draft.text || ""; $("message-input").value = draft.chatText || "";
      $("manual-form").elements.accountId.innerHTML = wallets(draft.manual?.accountId);
      for (const [name, value] of Object.entries(draft.manual || {})) if ($("manual-form").elements[name]) $("manual-form").elements[name].value = value;
      $("manual-form").hidden = !draft.manualOpen; $("capture-text-form").hidden = Boolean(draft.manualOpen);
      $("manual-date-label").textContent = draft.manual?.paymentState === "scheduled" ? "Vencimento" : "Data";
      $("draft-status").textContent = localCaptures.persistent ? "Rascunho salvo neste aparelho" : "Rascunho mantido somente nesta sessão";
      $("draft-status").hidden = !hasDraft(draft);
    }
    await refreshLocalNotice();
  } catch (error) { toast(error.message); }
}
function persistDraft(strict = false) {
  if (!currentLocalContext() || state.localKey !== currentLocalContext()) return Promise.resolve();
  const snapshot = draftSnapshot();
  state.draftWrites = state.draftWrites.catch(() => {}).then(async () => {
    if (hasDraft(snapshot)) await localCaptures.put("drafts", snapshot);
    else await localCaptures.remove("drafts", snapshot.context);
    if (currentLocalContext() !== snapshot.context) return;
    $("draft-status").textContent = localCaptures.persistent ? "Rascunho salvo neste aparelho" : "Rascunho mantido somente nesta sessão";
    $("draft-status").hidden = !hasDraft(snapshot);
    await refreshLocalNotice();
  });
  return state.draftWrites.catch((error) => { feedback("draft-status", error.message, true); if (strict === true) throw error; });
}
async function refreshLocalNotice() {
  const context = currentLocalContext();
  if (!context) return;
  try {
    const pending = await localCaptures.pending(context);
    const draft = remainingDraft(await localCaptures.draft(context), pending);
    if (context !== currentLocalContext()) return;
    $("device-notice").hidden = !pending.length && !hasDraft(draft);
    $("device-count").textContent = pending.length ? pending.length + (pending.length === 1 ? " envio guardado" : " envios guardados") : "Rascunho neste aparelho";
    $("device-caption").textContent = localCaptures.persistent ? "Retomar sem duplicar o envio" : "Disponível apenas nesta sessão";
    $("device-space").textContent = activeSpace();
    $("device-draft").innerHTML = hasDraft(draft) ? '<div class="local-attempt"><button type="button" class="item-row" data-resume-draft><span class="row-symbol">' + icon("pencil") + '</span><span class="item-main"><strong>Rascunho não enviado</strong><small>' + escape(draft.text || draft.chatText || draft.manual?.description || "Registro manual") + '</small></span>' + icon("chevron-right") + '</button><button type="button" class="icon-button danger" data-remove-draft title="Descartar rascunho local" aria-label="Descartar rascunho local">' + icon("trash-2") + "</button></div>" : "";
    $("device-outbox").innerHTML = pending.map((item) => '<div class="local-attempt"><button type="button" class="item-row" data-resume-attempt="' + escape(item.id) + '"><span class="row-symbol review">' + icon(item.multipart ? "paperclip" : "refresh-cw") + '</span><span class="item-main"><strong>' + escape(item.label || "Registro") + '</strong><small>' + (item.attempted ? "Recebimento não confirmado" : "Aguardando envio") + '</small></span>' + icon("arrow-right") + '</button><button class="icon-button danger" type="button" data-remove-attempt="' + escape(item.id) + '" title="Remover envio local" aria-label="Remover envio local">' + icon("trash-2") + "</button></div>").join("") || (!hasDraft(draft) ? '<p class="empty">Nenhum rascunho ou envio neste aparelho.</p>' : "");
    icons();
  } catch (error) { toast(error.message); }
}
async function clearAttemptDraft(attempt) {
  if (attempt.context !== currentLocalContext()) return;
  if (attempt.url === "/api/chat") {
    const input = $(attempt.origin === "chat" ? "message-input" : "capture-text");
    if (input.value.trim() === attempt.payload.message) input.value = "";
  } else if (attempt.url === "/api/transactions") {
    const form = $("manual-form");
    if (Object.entries(Object.fromEntries(new FormData(form))).every(([key, value]) => String(attempt.payload[key] ?? "") === value)) {
      form.reset(); form.hidden = true; $("capture-text-form").hidden = false;
    }
  }
  await persistDraft(true);
}
async function transmitAttempt(attempt) {
  if (attempt.context !== currentLocalContext()) throw new Error("Troque para o espaço deste envio antes de retomá-lo.");
  try {
    if (!navigator.onLine) throw Object.assign(new Error("Sem conexão."), { retryable: true });
    attempt.attempted = true;
    await localCaptures.put("outbox", attempt);
    const result = await request(attempt.url, attemptBody(attempt), attempt.multipart, attempt);
    render(result);
    attempt.completed = true;
    await localCaptures.put("outbox", attempt);
    await clearAttemptDraft(attempt);
    await localCaptures.remove("outbox", attempt.id);
    await refreshLocalNotice();
    return result;
  } catch (error) {
    if (error.retryable === false) await localCaptures.remove("outbox", attempt.id);
    await refreshLocalNotice();
    if (error.retryable !== false) {
      $("capture-local-retry").hidden = false;
      throw new Error((localCaptures.persistent ? "Envio guardado neste aparelho." : "Envio mantido nesta sessão.") + " Retome em “Neste aparelho”; a mesma tentativa não cria outro lançamento.");
    }
    throw error;
  }
}
$("capture-text").addEventListener("input", persistDraft);
$("message-input").addEventListener("input", persistDraft);
$("manual-form").addEventListener("input", persistDraft);
$("capture-local-retry").onclick = () => { $("capture-dialog").close(); openPanel("device"); };
function wallets(selected, first = "Sem carteira") {
  return '<option value="">' + first + "</option>" + (state.data?.wallets || []).map((wallet) =>
    '<option value="' + escape(wallet.id) + '"' + (String(selected || "") === String(wallet.id) ? " selected" : "") + ">" + escape(wallet.name) + "</option>").join("");
}
function syncPaymentLabels(form) {
  const income = form.elements.kind.value === "income";
  form.elements.paymentState.options[0].textContent = income ? "Recebida" : "Paga";
  form.elements.paymentState.options[1].textContent = income ? "A receber" : "A pagar";
}
function renderSession() {
  $("user-name").textContent = state.session?.user?.name || "";
  $("control-select").innerHTML = (state.session?.controls || []).map((control) => '<option value="' + escape(control.id) + '">' + escape(control.name) + "</option>").join("");
  $("control-select").value = state.session?.activeControlId || "";
  $("ledger-space-label").textContent = "Espaço: " + activeSpace();
  $("chat-space-label").textContent = "No espaço: " + activeSpace();
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
  const attentionCount = pending.filter((item) => item.review?.needsAttention).length;
  $("review-notice").querySelector("small").textContent = attentionCount ? attentionCount + (attentionCount === 1 ? " lançamento com aviso" : " lançamentos com avisos") : "Conferir antes de salvar";
  $("chat-pending-count").hidden = !pending.length;
  $("chat-pending-count").textContent = pending.length;
  const bills = data.transactions.filter((item) => item.status === "scheduled").sort((a, b) => (a.dueDate || a.transactionDate).localeCompare(b.dueDate || b.transactionDate));
  $("home-bills").innerHTML = bills.slice(0, 3).map((item) => transactionRow(item, true)).join("") || '<p class="empty">' + icon("circle-check") + "Nenhuma conta em aberto.</p>";
  const recentGroups = groupDrafts(data.transactions.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  $("recent-transactions").innerHTML = recentGroups.slice(0, 4).map((group) => transactionRow({ ...group[0], seriesCount: group.length })).join("") || '<div class="empty">' + icon("receipt-text") + '<p>Seu primeiro lançamento começa aqui.</p><button type="button" class="text-button" data-register>Registrar agora</button></div>';
  $("pending-transactions").innerHTML = groupDrafts(pending).map((group) => '<button class="item-row" type="button" data-drafts="' + escape(group.map((item) => item.id).join(",")) + '">' + '<span class="row-symbol review">' + icon("clipboard-check") + '</span><span class="item-main"><strong>' + escape(group[0].description) + '</strong><small>' + (group.length > 1 ? group.length + " meses · " : "") + escape(group[0].category) + ' · Ainda não salvo</small>' + (group.some((item) => item.review?.needsAttention) ? '<small class="review-label">' + icon("triangle-alert") + (group.some((item) => item.review?.duplicateCount) ? "Possível duplicidade" : "Dados para conferir") + '</small>' : "") + '</span><span class="item-end"><strong>' + money(group[0].amount) + (group.length > 1 ? "/mês" : "") + "</strong>" + icon("chevron-right") + "</span></button>").join("") || '<p class="empty">' + icon("circle-check") + "Tudo revisado.</p>";
  renderLedger();
  renderBills();
  renderMessages();
  renderReports();
  renderDocuments();
  renderWallets();
  const context = currentLocalContext();
  if (context && state.localKey !== context) state.localReady = activateLocalContext(context);
  else refreshLocalNotice();
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
  $("selection-count").textContent = state.selected.size + (state.selected.size === 1 ? " selecionado" : " selecionados");
  $("bulk-edit").disabled = !state.selected.size;
  $("move-selected").hidden = !canMoveBetweenControls();
  $("move-selected").disabled = !state.selected.size;
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
  const comparison = event.target.closest("[data-review-transaction]");
  if (comparison && !state.busy) openDetail(comparison.dataset.reviewTransaction);
  const resume = event.target.closest("[data-resume-attempt]");
  const removeAttempt = event.target.closest("[data-remove-attempt]");
  if (resume && !state.busy) {
    localCaptures.pending(currentLocalContext()).then((pending) => {
      const attempt = pending.find((item) => item.id === resume.dataset.resumeAttempt);
      if (!attempt) return;
      if (attempt.origin === "chat") { openPanel("chat"); sendChat(attempt.payload.message, attempt); }
      else captureRequest(attempt.url, attemptBody(attempt), "Retomando seu envio…", attempt.multipart, attempt);
    }).catch((error) => toast(error.message));
  }
  if (removeAttempt && !state.busy && confirm("Remover esta tentativa do aparelho? Isso não exclui lançamentos que o servidor já possa ter recebido.")) {
    task(async () => { await localCaptures.remove("outbox", removeAttempt.dataset.removeAttempt); await refreshLocalNotice(); });
  }
  if (event.target.closest("[data-resume-draft]")) {
    if ($("message-input").value && !$("capture-text").value && !$("manual-form").elements.amount.value && !$("manual-form").elements.description.value) openPanel("chat");
    else openCapture();
  }
  if (event.target.closest("[data-remove-draft]") && !state.busy && confirm("Descartar o rascunho deste aparelho? Nenhum lançamento salvo no servidor será removido.")) {
    task(async () => {
      await state.draftWrites.catch(() => {});
      await localCaptures.remove("drafts", currentLocalContext());
      state.localReady = activateLocalContext(currentLocalContext());
      await state.localReady;
    });
  }
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

async function openCapture() {
  if (!state.data) { toast("Carregue o espaço financeiro antes de registrar."); return; }
  if (state.busy || state.audio || state.audioStarting) return;
  const context = currentLocalContext();
  await state.localReady;
  if (state.busy || context !== currentLocalContext()) return false;
  if (captureDrafts(state.data, state.captureIds).length) { showCapture(state.captureIds); return false; }
  state.captureIds = [];
  $("capture-title").textContent = "Registrar";
  $("capture-space").textContent = activeSpace();
  $("capture-entry").hidden = false;
  $("capture-result").hidden = true;
  $("capture-error").hidden = true;
  $("capture-local-retry").hidden = true;
  $("capture-progress").hidden = true;
  $("manual-form").elements.transactionDate.value ||= localDate();
  $("manual-form").elements.accountId.innerHTML = wallets($("manual-form").elements.accountId.value);
  syncPaymentLabels($("manual-form"));
  openSheet("capture-dialog");
  return true;
}
$("register-button").onclick = openCapture;
$("capture-dialog").addEventListener("close", () => { state.captureIds = []; });
$("manual-toggle").onclick = () => {
  $("manual-form").hidden = !$("manual-form").hidden;
  $("capture-text-form").hidden = !$("manual-form").hidden;
  if (!$("manual-form").hidden) $("manual-form").elements.amount.focus();
  persistDraft();
};
$("manual-form").elements.paymentState.onchange = () => { $("manual-date-label").textContent = $("manual-form").elements.paymentState.value === "scheduled" ? "Vencimento" : "Data"; };
$("manual-form").elements.kind.onchange = () => syncPaymentLabels($("manual-form"));
function captureProgress(text) {
  $("capture-entry").hidden = true; $("capture-result").hidden = true;
  $("capture-progress").hidden = false; $("capture-progress-text").textContent = text;
  $("capture-error").hidden = true;
}
async function captureRequest(url, body, progress, multipart = false, savedAttempt = null) {
  if (state.busy || state.audio || state.audioStarting || state.captureStarting) return;
  state.captureStarting = true;
  try {
  if (!(await openCapture())) return;
  await task(async () => {
    captureProgress(progress);
    try {
      const label = multipart ? body.get(url === "/api/audio" ? "audio" : "file")?.name : body.description || body.message;
      const attempt = savedAttempt || await localCaptures.enqueue(currentLocalContext(), url, body, multipart, label || "Registro");
      const data = await transmitAttempt(attempt);
      const ids = data.capture?.transactionIds || [];
      const last = data.messages?.find((message) => String(message.id) === String(data.capture?.messageId));
      if (last?.role === "assistant" && ids.length) state.chatDrafts.set(String(last.id), ids);
      if (captureDrafts(data, ids).length) {
        showCapture(ids);
      } else if (ids.length && data.capture?.replayed) {
        $("capture-dialog").close(); toast("Este envio já foi processado. Nenhum lançamento foi duplicado.");
      } else {
        $("capture-entry").hidden = false;
        const message = last?.content || "Não encontrei um lançamento. Informe o valor e a descrição, ou use o registro manual.";
        feedback("capture-error", message);
      }
    } finally { $("capture-progress").hidden = true; }
  }, "capture-error");
  if (!state.captureIds.length) $("capture-entry").hidden = false;
  } finally { state.captureStarting = false; }
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
function captureReview(items) {
  const issues = new Map();
  const documents = new Map();
  const duplicates = new Map();
  const duplicateIds = new Set();
  const fields = new Set();
  for (const item of items) {
    for (const issue of item.review?.issues || []) {
      issues.set(issue.code, issue);
      for (const field of issue.fields || []) fields.add(field);
    }
    for (const document of item.review?.documents || []) documents.set(String(document.id), document);
    for (const duplicate of item.review?.duplicates || []) duplicates.set(String(duplicate.id), duplicate);
    for (const id of item.review?.duplicateIds || []) duplicateIds.add(String(id));
  }
  return { issues: [...issues.values()], documents: [...documents.values()], duplicates, duplicateIds: [...duplicateIds], fields };
}
function reviewField(field, text, fields) {
  return fields.has(field) ? '<span class="review-field" title="Dado para conferir">' + escape(text) + icon("circle-alert") + '</span>' : escape(text);
}
function reviewDocuments(items) {
  const documents = captureReview(items).documents;
  if (!documents.length) return "";
  return '<div class="review-documents">' + documents.map((document) => {
    const url = "/api/documents/" + encodeURIComponent(document.id) + "/view";
    return '<a class="review-document" href="' + url + '" target="_blank" rel="noopener">' +
      (String(document.mimeType || "").startsWith("image/") ? '<img class="receipt-thumbnail" src="' + url + '?raw=1" alt="Prévia do comprovante" loading="lazy" />' : '<span class="review-file-icon">' + icon("file-text") + '</span>') +
      '<span><strong>Ver comprovante</strong><small>' + escape(document.originalName) + '</small></span>' + icon("external-link") + '</a>';
  }).join("") + '</div>';
}
document.addEventListener("error", (event) => {
  if (!event.target.classList?.contains("receipt-thumbnail")) return;
  const fallback = document.createElement("span");
  fallback.className = "review-file-icon";
  fallback.setAttribute("aria-hidden", "true");
  fallback.innerHTML = icon("file-text");
  event.target.replaceWith(fallback);
  icons();
}, true);
function reviewNotices(items, interactive = true) {
  const review = captureReview(items);
  if (!review.issues.length && !review.duplicateIds.length) return "";
  let content = review.issues.map((issue) => '<p class="review-issue">' + icon("circle-alert") + '<span>' + escape(issue.message) + '</span></p>').join("");
  if (review.duplicateIds.length) {
    const count = review.duplicateIds.length;
    content += '<details class="duplicate-notice"' + (count <= 3 ? ' open' : '') + '><summary>' + icon("copy") + '<span>Possível duplicidade<small>' + count + (count === 1 ? ' registro encontrado' : ' registros encontrados') + '</small></span>' + icon("chevron-down") + '</summary><div class="duplicate-candidates">' + review.duplicateIds.map((id) => {
      const candidate = findTransaction(id) || review.duplicates.get(id);
      if (!candidate) return "";
      const reason = review.duplicates.get(id)?.reason === "same_document" ? "Mesmo arquivo" : "Dados financeiros semelhantes";
      const tag = interactive ? 'button type="button" data-review-transaction="' + escape(id) + '"' : 'div';
      const close = interactive ? 'button' : 'div';
      return '<' + tag + ' class="duplicate-row"><span><strong>' + escape(candidate.description) + '</strong><small>' + date(candidate.dueDate || candidate.transactionDate) + ' · ' + (candidate.status === "pending" ? "Rascunho" : candidate.status === "scheduled" ? "Em aberto" : "Já salvo") + '</small><small>' + reason + '</small></span><strong>' + money(candidate.amount) + '</strong></' + close + '>';
    }).join("") + '</div></details>';
  }
  return '<section class="review-notices" aria-label="Avisos da conferência">' + content + '</section>';
}
function syncCaptureSave() {
  const drafts = captureDrafts(state.data || {}, state.captureIds);
  const hasDuplicates = captureReview(drafts).duplicateIds.length > 0;
  $("capture-duplicate-check").hidden = !hasDuplicates;
  $("capture-save").disabled = state.busy || !drafts.length || (hasDuplicates && !$("capture-duplicate-ack").checked);
}
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
    const review = captureReview(group);
    const unpaid = group.filter((entry) => entry.dueDate).length;
    const paymentLabel = group.length > 1 && unpaid > 0 && unpaid < group.length
      ? "Primeiro realizado · Próximos em aberto"
      : item.dueDate ? (item.kind === "income" ? "A receber" : "A pagar") : (item.kind === "income" ? "Recebida" : "Paga");
    const sameAmount = new Set(group.map((entry) => Number(entry.amount))).size === 1;
    const sameWallet = new Set(group.map((entry) => entry.accountId || "")).size === 1;
    const walletName = sameWallet ? item.accountName || state.data.wallets?.find((wallet) => String(wallet.id) === String(item.accountId))?.name || "Sem carteira" : "Carteiras diferentes";
    const amount = sameAmount ? item.amount : group.reduce((sum, entry) => sum + Number(entry.amount), 0);
    return '<article class="capture-card"><span class="eyebrow">' +
      (item.kind === "income" ? "Receita" : "Despesa") + " · " + reviewField("paymentState", paymentLabel, review.fields) +
      '</span><h2>' + escape(item.description) + '</h2>' + reviewNotices(group) + reviewDocuments(group) + '<strong class="capture-value' + (review.fields.has("amount") ? ' review-value' : '') + '">' +
      money(amount) + (group.length > 1 ? '<small>' + (sameAmount ? " por mês" : " no total · valores variáveis") + "</small>" : "") +
      '</strong><dl><div><dt>' + (item.dueDate ? "Vencimento" : "Data") + '</dt><dd>' +
      reviewField("date", date(item.dueDate || item.transactionDate), review.fields) + '</dd></div><div><dt>Categoria</dt><dd>' +
      reviewField("category", item.category, review.fields) + '</dd></div><div><dt>Carteira</dt><dd>' + escape(walletName) +
      '</dd></div>' + (group.length > 1 ? '<div><dt>Repetição</dt><dd>' + group.length +
      " meses, até " + date(group.at(-1).dueDate || group.at(-1).transactionDate) + '</dd></div>' : "") +
      '</dl>' + (groups.length > 1 ? '<button type="button" class="text-button" data-transaction="' +
      escape(item.id) + '">' + icon("pencil") + "Editar dados</button>" : "") + "</article>";
  }).join("");
  $("capture-result-note").textContent = drafts.length > 1 ? "Serão salvos " + drafts.length + " lançamentos desta captura. Total: " + money(drafts.reduce((sum, item) => sum + Number(item.amount), 0)) + "." : "O lançamento só entra nos seus totais ao salvar.";
  $("capture-save").innerHTML = icon("check") + (drafts.length > 1 ? "Salvar " + drafts.length + " lançamentos" : "Salvar lançamento");
  $("capture-duplicate-ack").checked = false;
  syncCaptureSave();
  $("capture-edit").onclick = () => drafts.length > 1 && drafts[0].recurrenceGroupId ? openRecurrence(drafts[0]) : openDetail(drafts[0].id);
  openSheet("capture-dialog");
}
$("capture-save").onclick = () => task(async () => {
  const drafts = captureDrafts(state.data, state.captureIds);
  if (!drafts.length) throw new Error("Esta captura já foi salva ou descartada. Atualize a tela para conferir.");
  const duplicateIds = captureReview(drafts).duplicateIds;
  if (duplicateIds.length && !$("capture-duplicate-ack").checked) throw new Error("Confira os possíveis duplicados e marque a confirmação antes de salvar.");
  try {
    render(await request("/api/transactions/confirm", { ids: drafts.map((item) => item.id), reviewedDuplicateIds: $("capture-duplicate-ack").checked ? duplicateIds : [] }));
  } catch (error) {
    if (error.code === "duplicate_review_required" && error.response?.summary) { render(error.response); showCapture(state.captureIds); }
    throw error;
  }
  state.captureIds = [];
  $("capture-dialog").close();
  $("manual-form").reset(); $("manual-form").hidden = true; $("capture-text-form").hidden = false;
  toast(drafts.length === 1 ? "Lançamento salvo." : drafts.length + " lançamentos salvos.", async () => {
    for (const item of drafts) render(await request("/api/transactions/" + encodeURIComponent(item.id) + "/remove", {}));
    toast("Registro desfeito.");
  });
}, "capture-error");
$("capture-duplicate-ack").onchange = syncCaptureSave;
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
  syncPaymentLabels(form);
  form.elements.kind.onchange = () => syncPaymentLabels(form);
  if (item.status === "pending") {
    form.insertAdjacentHTML("beforebegin", reviewNotices([item], false) + reviewDocuments([item]));
    const fields = captureReview([item]).fields;
    const inputs = { amount: ["amount"], date: ["transactionDate", "dueDate"], paymentState: ["paymentState"], category: ["category"] };
    for (const [field, names] of Object.entries(inputs)) {
      if (!fields.has(field)) continue;
      for (const name of names) form.elements[name].closest("label").classList.add("review-input");
    }
  }
  if (item.status !== "pending") {
    $("detail-title").textContent = "Detalhes";
    form.hidden = true;
    form.insertAdjacentHTML("beforebegin", '<section id="detail-summary"><p class="eyebrow">' + escape(item.category) + '</p><h2>' + escape(item.description) + '</h2><strong class="capture-value ' + item.kind + '">' + money(item.amount) + '</strong><p class="list-caption">' + date(item.dueDate || item.transactionDate) + " · " + escape(item.accountName || "Sem carteira") + '</p>' + reviewDocuments([item]) + '<button id="detail-edit-button" class="text-button" type="button">' + icon("pencil") + 'Editar dados</button>' + (canMoveBetweenControls() ? '<button id="detail-move-button" class="text-button" type="button">' + icon("folder-symlink") + 'Mover para outro espaço</button>' : "") + '</section>');
    $("detail-edit-button").onclick = () => {
      form.hidden = false; $("detail-summary").hidden = true;
      $("detail-title").textContent = "Editar lançamento";
      if ($("payment-form")) $("payment-form").hidden = true;
    };
  }
  const updateDue = () => { $("detail-due").hidden = form.elements.paymentState.value !== "scheduled"; form.elements.dueDate.required = !$("detail-due").hidden; };
  form.elements.paymentState.onchange = updateDue; updateDue();
  const detailInitialValues = JSON.stringify(Object.fromEntries(new FormData(form)));
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
  if ($("detail-series")) {
    $("detail-series").querySelector("span").textContent = "Gerenciar série recorrente";
    $("detail-series").onclick = () => {
      if (JSON.stringify(Object.fromEntries(new FormData(form))) !== detailInitialValues) { feedback("detail-error", "Salve a edição antes de alterar a série.", true); return; }
      openRecurrence(item);
    };
  }
  if (item.recurrenceGroupId && $("detail-summary") && canEditCurrentSpace()) {
    $("detail-summary").insertAdjacentHTML("beforeend", '<button type="button" id="detail-manage-series" class="text-button">' + icon("repeat-2") + 'Gerenciar série</button>');
    $("detail-manage-series").onclick = () => { $("detail-dialog").close(); openRecurrence(item); };
  }
  if ($("detail-move-button")) $("detail-move-button").onclick = () => {
    $("detail-dialog").close();
    openMove([id]);
  };
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
function canEditCurrentSpace() {
  const active = state.session?.controls?.find((control) => String(control.id) === String(state.session.activeControlId));
  return Boolean(active && ["owner", "editor"].includes(active.role));
}
function recurrenceInput() {
  const form = $("recurrence-form");
  return { anchorId: String(state.recurrenceAnchor.id), action: state.recurrenceAction, scope: form.elements.scope.value, ...(state.recurrenceAction === "reschedule" ? { day: Number(form.elements.day.value) } : {}) };
}
function syncRecurrenceSubmit() {
  const plan = state.recurrencePlan;
  const cancel = state.recurrenceAction === "cancel";
  const needsAck = Boolean(plan?.count && cancel);
  $("recurrence-cancel-check").hidden = !needsAck;
  $("recurrence-form").elements.confirmCancellation.required = needsAck;
  $("recurrence-submit").disabled = state.busy || Boolean(plan && (!plan.count || (cancel && !$("recurrence-form").elements.confirmCancellation.checked)));
  $("recurrence-submit").classList.toggle("cancel-series", Boolean(plan && cancel));
  $("recurrence-submit").innerHTML = icon(plan ? cancel ? "ban" : "check" : "list-checks") + (plan ? cancel ? "Confirmar cancelamento" : "Aplicar vencimentos" : "Conferir alterações");
  icons();
}
function invalidateRecurrence() {
  state.recurrencePlan = null; state.recurrenceLimit = 50;
  $("recurrence-preview").hidden = true;
  $("recurrence-error").hidden = true;
  $("recurrence-form").elements.confirmCancellation.checked = false;
  const cancel = state.recurrenceAction === "cancel";
  $("recurrence-day-field").hidden = cancel;
  $("recurrence-form").elements.day.required = !cancel;
  $("recurrence-policy").textContent = cancel ? "As parcelas listadas serão retiradas do extrato. Pagamentos e recebimentos já registrados serão preservados." : "Meses mais curtos usam o último dia do mês. Pagamentos e recebimentos já registrados serão preservados.";
  all("[data-recurrence-action]").forEach((button) => { const active = button.dataset.recurrenceAction === state.recurrenceAction; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
  syncRecurrenceSubmit();
}
function showRecurrencePlan(plan) {
  state.recurrencePlan = plan;
  const count = plan.count;
  const cancel = plan.action === "cancel";
  const heading = count ? count + (count === 1 ? " parcela " : " parcelas ") + (cancel ? count === 1 ? "será cancelada" : "serão canceladas" : count === 1 ? "terá novo vencimento" : "terão novos vencimentos") : "Nenhuma alteração nesta seleção";
  $("recurrence-preview").innerHTML = '<h2>' + heading + '</h2>' + (plan.preservedCount ? '<p class="list-caption">' + plan.preservedCount + (plan.preservedCount === 1 ? ' lançamento pago ou recebido preservado.' : ' lançamentos pagos ou recebidos preservados.') + '</p>' : '') +
    '<div class="recurrence-items">' + plan.items.slice(0, state.recurrenceLimit).map((item) => '<div class="recurrence-row"><span><strong>' + escape(item.description) + '</strong><small>' + date(item.oldDate) + (item.newDate ? ' ' + icon("arrow-right") + ' ' + date(item.newDate) : '') + '</small><small>' + (item.status === "pending" ? "Rascunho" : item.kind === "income" ? "A receber" : "A pagar") + '</small></span><strong>' + money(item.amount) + '</strong></div>').join("") + '</div>' +
    (count > state.recurrenceLimit ? '<button id="recurrence-more" type="button" class="text-button">Ver todas as ' + count + ' parcelas</button>' : '') + (!count ? '<p class="list-caption">Não há parcelas em aberto para alterar, ou os vencimentos já estão no dia escolhido.</p>' : '');
  $("recurrence-preview").hidden = false;
  if ($("recurrence-more")) $("recurrence-more").onclick = () => { state.recurrenceLimit = count; showRecurrencePlan(plan); };
  syncRecurrenceSubmit();
}
function openRecurrence(item) {
  if (!item?.recurrenceGroupId || !canEditCurrentSpace()) { toast("Você precisa ter permissão de edição para gerenciar esta série."); return; }
  state.recurrenceAnchor = item; state.recurrenceAction = "reschedule";
  $("recurrence-form").reset();
  $("recurrence-form").elements.scope.value = "next";
  $("recurrence-form").elements.day.value = Number((item.dueDate || item.transactionDate).slice(8, 10)) || 1;
  $("recurrence-space").textContent = "Espaço: " + activeSpace();
  $("recurrence-description").textContent = item.description.replace(/\s+\(\d+\/\d+\)$/, "");
  invalidateRecurrence(); openSheet("recurrence-dialog");
}
all("[data-recurrence-action]").forEach((button) => { button.onclick = () => { state.recurrenceAction = button.dataset.recurrenceAction; invalidateRecurrence(); }; });
$("recurrence-form").elements.scope.onchange = invalidateRecurrence;
$("recurrence-form").elements.day.oninput = invalidateRecurrence;
$("recurrence-form").elements.confirmCancellation.onchange = syncRecurrenceSubmit;
$("recurrence-values").onclick = () => { $("recurrence-dialog").close(); openBulk(state.recurrenceAnchor); };
$("recurrence-form").onsubmit = (event) => {
  event.preventDefault();
  task(async () => {
    const input = recurrenceInput();
    const plan = state.recurrencePlan;
    const controls = [$("recurrence-form").elements.scope, $("recurrence-form").elements.day];
    controls.forEach((control) => { control.disabled = true; });
    try {
      if (!plan) { showRecurrencePlan((await request("/api/recurrences/preview", input)).plan); return; }
      const result = await request("/api/recurrences/apply", { ...input, token: plan.token, confirmCancellation: $("recurrence-form").elements.confirmCancellation.checked });
      render(result); $("recurrence-dialog").close();
      if ($("detail-dialog").open) $("detail-dialog").close();
      if ($("capture-dialog").open) showCapture(state.captureIds);
      const count = result.recurrence.changedCount;
      toast(count + (count === 1 ? " parcela " : " parcelas ") + (input.action === "cancel" ? count === 1 ? "cancelada." : "canceladas." : count === 1 ? "com vencimento atualizado." : "com vencimentos atualizados."));
    } catch (error) { invalidateRecurrence(); throw error; }
    finally { controls.forEach((control) => { control.disabled = false; }); }
  }, "recurrence-error");
};

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

function expandedMoveTargets(ids) {
  return moveTargets([...(state.data?.transactions || []), ...(state.data?.pendingTransactions || [])], ids);
}
function previewMove() {
  if (!state.data || !state.moveIds.length) { $("move-submit").disabled = true; return; }
  const targets = expandedMoveTargets(state.moveIds);
  const groups = new Set(targets.map((item) => item.recurrenceGroupId).filter(Boolean));
  const pending = targets.filter((item) => item.status === "pending").length;
  const form = $("move-form");
  $("move-caption").textContent = "Origem: " + activeSpace() + ". " + targets.length + (targets.length === 1 ? " lançamento" : " lançamentos") + ", total de " + money(targets.reduce((sum, item) => sum + Number(item.amount), 0)) + ".";
  $("move-preview").textContent = (groups.size ? groups.size + (groups.size === 1 ? " série inteira" : " séries inteiras") + ", incluindo parcelas de outros meses. " : "") + (pending ? "Inclui " + pending + (pending === 1 ? " rascunho. " : " rascunhos. ") : "") + "Valores, datas e situação serão mantidos.";
  const choice = form.elements.walletChoice.value;
  let walletNote = "";
  if (state.moveLoading) walletNote = "Carregando carteiras do destino…";
  else if (choice === "none") walletNote = "Todos os lançamentos ficarão sem carteira.";
  else if (choice === "match" && state.moveWallets !== null) {
    const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    const unmatched = targets.filter((item) => item.accountId && state.moveWallets.filter((wallet) => normalize(wallet.name) === normalize(item.accountName)).length !== 1);
    walletNote = unmatched.length ? unmatched.length + (unmatched.length === 1 ? " lançamento ficará" : " lançamentos ficarão") + " sem carteira: não há uma carteira equivalente e única no destino." : "As carteiras serão associadas pelo mesmo nome; itens sem carteira continuarão assim.";
  }
  $("move-wallet-note").textContent = walletNote;
  $("move-wallet-note").hidden = !walletNote;
  $("move-submit").disabled = state.busy || state.moveLoading || !form.elements.destinationControlId.value || state.moveWallets === null || targets.length > 500 || state.moveIds.length > 100;
}
function openMove(ids) {
  if (!canMoveBetweenControls()) { toast("Você precisa ter permissão de edição em dois espaços para mover lançamentos."); return; }
  try {
    state.moveIds = [...new Set(ids.map(String))];
    state.moveWallets = null; state.moveLoading = false; state.moveWalletRequest += 1;
    const targets = expandedMoveTargets(state.moveIds);
    $("move-error").hidden = true;
    $("move-wallet-retry").hidden = true;
    $("move-form").reset();
    const destination = $("move-form").elements.destinationControlId;
    destination.innerHTML = '<option value="">Escolha um espaço</option>' + editableMoveDestinations().map((control) => '<option value="' + escape(control.id) + '">' + escape(control.name) + '</option>').join("");
    $("move-wallet-mode").innerHTML = '<option value="match">Correspondência automática pelo nome</option><option value="none">Sem carteira</option>';
    $("move-wallet-mode").disabled = false;
    if (targets.length > 500) feedback("move-error", "A seleção inclui mais de 500 lançamentos. Divida a movimentação em grupos menores.", true);
    else if (state.moveIds.length > 100) feedback("move-error", "Selecione no máximo 100 lançamentos por vez.", true);
    previewMove(); openSheet("move-dialog");
  } catch (error) { toast(error.message); }
}
async function loadMoveWallets(controlId) {
  const requestId = ++state.moveWalletRequest;
  const select = $("move-wallet-mode");
  state.moveWallets = null; state.moveLoading = Boolean(controlId);
  $("move-wallet-retry").hidden = true;
  select.innerHTML = '<option value="match">Correspondência automática pelo nome</option><option value="none">Sem carteira</option>';
  select.disabled = Boolean(controlId);
  previewMove();
  if (!controlId) return;
  try {
    const result = await request("/api/controls/" + encodeURIComponent(controlId) + "/wallets");
    if (requestId !== state.moveWalletRequest) return;
    state.moveWallets = result.wallets || [];
    for (const wallet of state.moveWallets) {
      select.insertAdjacentHTML("beforeend", '<option value="specific:' + escape(wallet.id) + '">Usar carteira: ' + escape(wallet.name) + '</option>');
    }
  } catch (error) {
    if (requestId !== state.moveWalletRequest) return;
    feedback("move-error", error.message, true);
    $("move-wallet-retry").hidden = false;
  } finally {
    if (requestId === state.moveWalletRequest) { state.moveLoading = false; select.disabled = false; previewMove(); }
  }
}
$("move-form").elements.destinationControlId.onchange = () => {
  $("move-error").hidden = true;
  loadMoveWallets($("move-form").elements.destinationControlId.value);
};
$("move-selected").onclick = () => openMove([...state.selected]);
$("move-wallet-mode").onchange = previewMove;
$("move-wallet-retry").onclick = () => {
  $("move-error").hidden = true;
  loadMoveWallets($("move-form").elements.destinationControlId.value);
};
$("move-dialog").addEventListener("close", () => { state.moveWalletRequest += 1; });
$("move-form").onsubmit = (event) => {
  event.preventDefault();
  task(async () => {
    const form = event.currentTarget;
    const destinationControlId = form.elements.destinationControlId.value;
    if (!destinationControlId) throw new Error("Escolha o espaço de destino.");
    if (state.moveLoading || state.moveWallets === null) throw new Error("Aguarde o carregamento das carteiras do destino.");
    if (state.moveIds.length > 100) throw new Error("Selecione no máximo 100 lançamentos por vez.");
    const targets = expandedMoveTargets(state.moveIds);
    if (targets.length > 500) throw new Error("A seleção inclui mais de 500 lançamentos. Divida a movimentação em grupos menores.");
    const walletChoice = form.elements.walletChoice.value;
    const body = { ids: state.moveIds, destinationControlId, walletMode: "match" };
    if (walletChoice === "none") body.walletMode = "none";
    else if (walletChoice.startsWith("specific:")) {
      body.walletMode = "specific";
      body.destinationAccountId = walletChoice.slice("specific:".length);
    }
    const result = await request("/api/transactions/move", body);
    render(result);
    $("move-dialog").close();
    if ($("detail-dialog").open) $("detail-dialog").close();
    state.selected.clear(); state.selecting = false; state.moveIds = [];
    renderLedger();
    const move = result.move || {};
    const movedCount = move.movedCount || targets.length;
    let message = movedCount + (movedCount === 1 ? " lançamento movido para " : " lançamentos movidos para ") + (move.destinationName || "o outro espaço") + ".";
    if (move.unassignedWalletCount) message += " " + move.unassignedWalletCount + " sem carteira equivalente.";
    if (move.movedDocumentCount) message += " Comprovantes vinculados também foram movidos.";
    toast(message);
  }, "move-error");
};

$("chat-form").onsubmit = (event) => { event.preventDefault(); sendChat($("message-input").value.trim()); };
async function sendChat(message, savedAttempt = null) {
  if (!message || state.busy) return;
  await task(async () => {
    $("message-input").setAttribute("aria-busy", "true");
    $("messages").insertAdjacentHTML("beforeend", '<article id="chat-working" class="message assistant" role="status">' + icon("loader-circle") + " Consultando…</article>");
    icons(); $("messages").scrollTop = $("messages").scrollHeight;
    try {
      const attempt = savedAttempt || await localCaptures.enqueue(currentLocalContext(), "/api/chat", { message }, false, message, "chat");
      const data = await transmitAttempt(attempt);
      const ids = data.capture?.transactionIds || [];
      if (ids.length && data.capture?.messageId) state.chatDrafts.set(String(data.capture.messageId), ids);
      renderMessages(); icons();
      $("messages").scrollTop = $("messages").scrollHeight;
      if (captureDrafts(data, ids).length) showCapture(ids);
      else if (ids.length && data.capture?.replayed) toast("Este envio já foi processado. Nenhum lançamento foi duplicado.");
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
  try { render(await request("/api/state")); await state.localReady; }
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
$("logout-button").onclick = () => task(async () => {
  const userId = state.session.user.id;
  await state.draftWrites.catch(() => {});
  const prefix = encodeURIComponent(String(userId)) + ":";
  const hasLocalData = (await localCaptures.all("outbox")).some((item) => item.context.startsWith(prefix)) ||
    (await localCaptures.all("drafts")).some((item) => item.context.startsWith(prefix) && hasDraft(item));
  if (hasLocalData && !confirm("Há rascunhos ou envios guardados neste aparelho. Sair da conta apagará essas cópias locais. Deseja sair mesmo assim?")) return;
  cancelAudio(); await request("/api/auth/logout", {});
  await state.draftWrites.catch(() => {});
  let cleanupError = null;
  try { await localCaptures.clearUser(userId); } catch (error) { cleanupError = error; }
  state.data = null; state.session = null; state.localKey = null; state.captureIds = []; state.chatDrafts.clear();
  $("capture-text").value = ""; $("message-input").value = ""; $("manual-form").reset();
  showAuth();
  if (cleanupError) toast("Você saiu da conta, mas não consegui limpar os rascunhos locais. Limpe os dados do site neste aparelho.");
});

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
    $("auth-password").value = ""; renderSession(); render(await request("/api/state")); await state.localReady;
    $("auth-screen").hidden = true; $("app-shell").hidden = false; openPanel("home");
  }, "auth-error");
};
window.addEventListener("offline", () => { persistDraft(); toast("Sem conexão. Seus envios ficam neste aparelho até você retomá-los."); });
window.addEventListener("online", () => { refreshLocalNotice(); toast("Conexão restabelecida. Você pode retomar os envios neste aparelho."); });
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
    renderSession(); render(await request("/api/state")); await state.localReady;
    $("auth-screen").hidden = true; $("app-shell").hidden = false;
  } catch (error) { feedback("auth-error", error.message, true); }
}
init();
