import { AsyncLocalStorage } from "node:async_hooks";
import { executeCapture } from "./capture-requests.js";
import { expandMoveRows, matchMoveWallet, normalizeMoveName } from "./transaction-move.js";
import { confirmationIds, unreviewedDuplicateIds } from "./transaction-review.js";

const defaultUser = {
  name: "Usuario principal",
  email: "usuario@local"
};

const welcomeMessage =
  "Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload.";

export class MariaDbStorage {
  constructor(config) {
    this.requestContext = new AsyncLocalStorage();
    this.config = config;
    this.pool = null;
    this.userId = null;
    this.controlId = null;
  }

  get pool() { return this.requestContext.getStore()?.pool ?? this.defaultPool; }
  set pool(value) { this.defaultPool = value; }
  get userId() { return this.requestContext.getStore()?.userId ?? this.defaultUserId; }
  set userId(value) {
    const context = this.requestContext.getStore();
    if (context) context.userId = value;
    else this.defaultUserId = value;
  }
  get controlId() { return this.requestContext.getStore()?.controlId ?? this.defaultControlId; }
  set controlId(value) {
    const context = this.requestContext.getStore();
    if (context) context.controlId = value;
    else this.defaultControlId = value;
  }

  runContext(action) {
    return this.requestContext.run({ userId: this.userId, controlId: this.controlId, pool: this.pool }, action);
  }

  async captureRequest(input, action, replay) {
    const connection = await this.pool.getConnection();
    const context = { userId: this.userId, controlId: this.controlId, pool: connection };
    try {
      return await this.requestContext.run(context, () => executeCapture(connection, { ...input, userId: context.userId, controlId: context.controlId }, action, replay));
    } finally { connection.release(); }
  }

  async init() {
    const mysql = await import("mysql2/promise");
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 8,
      namedPlaceholders: true,
      decimalNumbers: true
    });

    await this.ensureSchema();
    this.userId = await this.ensureDefaultUser();
    this.controlId = await this.ensureDefaultControl(this.userId);
    await this.ensureWelcomeMessage();
  }

  setContext(userId, controlId) {
    this.userId = userId;
    this.controlId = controlId;
  }

  async read() {
    const [messages] = await this.pool.execute(
      `SELECT CAST(id AS CHAR) AS id, role, content, created_at AS createdAt
       FROM chat_messages
       WHERE control_id = ?
       ORDER BY created_at ASC, id ASC`,
      [this.controlId]
    );

    const [transactions] = await this.pool.execute(
      `SELECT
         CAST(t.id AS CHAR) AS id,
         t.kind,
         t.status,
         t.amount,
         t.description,
         t.merchant,
         t.payment_method AS paymentMethod,
         CAST(t.account_id AS CHAR) AS accountId,
         a.name AS accountName,
         t.recurrence_group_id AS recurrenceGroupId,
         t.recurrence_index AS recurrenceIndex,
         t.recurrence_total AS recurrenceTotal,
         t.transaction_date AS transactionDate,
         t.due_date AS dueDate,
         COALESCE(c.name, 'Outros') AS category,
         t.source,
         t.raw_text AS rawText,
         t.confidence,
         t.created_at AS createdAt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN financial_accounts a ON a.id = t.account_id
       WHERE t.control_id = ?
       ORDER BY t.created_at DESC, t.id DESC`,
      [this.controlId]
    );

    const [documents] = await this.pool.execute(
      `SELECT
         CAST(id AS CHAR) AS id,
         original_name AS originalName,
         stored_name AS storedName,
         mime_type AS mimeType,
         content_hash AS contentHash,
         status,
         created_at AS createdAt
       FROM documents
       WHERE control_id = ?
       ORDER BY created_at DESC, id DESC`,
      [this.controlId]
    );

    const [documentLinks] = await this.pool.execute(
      `SELECT CAST(td.transaction_id AS CHAR) AS transactionId, CAST(td.document_id AS CHAR) AS documentId
       FROM transaction_documents td
       INNER JOIN transactions t ON t.id = td.transaction_id
       INNER JOIN documents d ON d.id = td.document_id AND d.control_id = t.control_id
       WHERE t.control_id = ?`,
      [this.controlId]
    );
    const documentIds = new Map();
    for (const link of documentLinks) {
      if (!documentIds.has(link.transactionId)) documentIds.set(link.transactionId, []);
      documentIds.get(link.transactionId).push(link.documentId);
    }

    const [wallets] = await this.pool.execute(
      `SELECT CAST(a.id AS CHAR) AS id, a.name, a.type, a.opening_balance AS openingBalance,
        a.opening_balance + COALESCE(SUM(CASE
          WHEN t.status IN ('confirmed', 'paid') AND t.kind = 'income' THEN t.amount
          WHEN t.status IN ('confirmed', 'paid') AND t.kind = 'expense' THEN -t.amount
          ELSE 0 END), 0) AS balance
       FROM financial_accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.control_id = ?
       GROUP BY a.id, a.name, a.type, a.opening_balance
       ORDER BY a.name`,
      [this.controlId]
    );

    return {
      messages: messages.map(normalizeDates),
      transactions: transactions.map((row) => ({ ...normalizeTransaction(row), documentIds: documentIds.get(String(row.id)) || [] })),
      documents: documents.map(normalizeDates),
      wallets
    };
  }

  async addMessage(message) {
    const [result] = await this.pool.execute(
      `INSERT INTO chat_messages (control_id, user_id, role, content) VALUES (?, ?, ?, ?)`,
      [this.controlId, this.userId, message.role, message.content]
    );
    return {
      id: String(result.insertId),
      role: message.role,
      content: message.content,
      createdAt: new Date().toISOString()
    };
  }

  async addTransaction(transaction) {
    const categoryId = await this.ensureCategory(transaction.category, transaction.kind);
    const [result] = await this.pool.execute(
      `INSERT INTO transactions (
         control_id, user_id, account_id, category_id, recurrence_group_id, recurrence_index, recurrence_total,
         kind, status, amount, description, merchant, payment_method, transaction_date, due_date, source, raw_text, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.controlId,
        this.userId,
        transaction.accountId || null,
        categoryId,
        transaction.recurrenceGroupId || null,
        transaction.recurrenceIndex || null,
        transaction.recurrenceTotal || null,
        transaction.kind,
        transaction.status,
        transaction.amount,
        transaction.description,
        transaction.merchant,
        transaction.paymentMethod,
        transaction.transactionDate,
        transaction.dueDate,
        transaction.source,
        transaction.rawText,
        transaction.confidence
      ]
    );

    return { id: String(result.insertId), createdAt: new Date().toISOString(), ...transaction };
  }

  async updateTransactionStatus(id, status) {
    await this.pool.execute(
      `UPDATE transactions SET status = ? WHERE id = ? AND control_id = ?`,
      [status, id, this.controlId]
    );
    const [rows] = await this.pool.execute(
      `SELECT
         CAST(t.id AS CHAR) AS id,
         t.kind,
         t.status,
         t.amount,
         t.description,
         t.merchant,
         t.payment_method AS paymentMethod,
         CAST(t.account_id AS CHAR) AS accountId,
         a.name AS accountName,
         t.recurrence_group_id AS recurrenceGroupId,
         t.recurrence_index AS recurrenceIndex,
         t.recurrence_total AS recurrenceTotal,
         t.transaction_date AS transactionDate,
         t.due_date AS dueDate,
         COALESCE(c.name, 'Outros') AS category,
         t.source,
         t.raw_text AS rawText,
         t.confidence,
         t.created_at AS createdAt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN financial_accounts a ON a.id = t.account_id
       WHERE t.id = ? AND t.control_id = ?
       LIMIT 1`,
      [id, this.controlId]
    );
    return rows[0] ? normalizeTransaction(rows[0]) : null;
  }

  async updateTransaction(id, changes) {
    const categoryId = await this.ensureCategory(changes.category, changes.kind);
    await this.pool.execute(
      `UPDATE transactions
       SET kind = ?,
           category_id = ?,
           amount = ?,
           description = ?,
           merchant = ?,
           payment_method = ?,
           account_id = ?,
           transaction_date = ?,
           due_date = ?,
           status = ?
       WHERE id = ? AND control_id = ? AND status <> 'dismissed'`,
      [
        changes.kind,
        categoryId,
        changes.amount,
        changes.description,
        changes.merchant,
        changes.paymentMethod,
        changes.accountId || null,
        changes.transactionDate,
        changes.dueDate,
        changes.status,
        id,
        this.controlId
      ]
    );

    const [rows] = await this.pool.execute(
      `SELECT
         CAST(t.id AS CHAR) AS id,
         t.kind,
         t.status,
         t.amount,
         t.description,
         t.merchant,
         t.payment_method AS paymentMethod,
         CAST(t.account_id AS CHAR) AS accountId,
         a.name AS accountName,
         t.recurrence_group_id AS recurrenceGroupId,
         t.recurrence_index AS recurrenceIndex,
         t.recurrence_total AS recurrenceTotal,
         t.transaction_date AS transactionDate,
         t.due_date AS dueDate,
         COALESCE(c.name, 'Outros') AS category,
         t.source,
         t.raw_text AS rawText,
         t.confidence,
         t.created_at AS createdAt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN financial_accounts a ON a.id = t.account_id
       WHERE t.id = ? AND t.control_id = ?
       LIMIT 1`,
      [id, this.controlId]
    );
    return rows[0] ? normalizeTransaction(rows[0]) : null;
  }

  async bulkUpdateTransactions({ ids = [], recurrenceGroupId = null, accountId, amount }) {
    const assignments = [];
    const assignmentParams = [];
    if (accountId !== undefined) {
      assignments.push("account_id = ?");
      assignmentParams.push(accountId || null);
    }
    if (amount !== undefined) {
      assignments.push("amount = ?");
      assignmentParams.push(amount);
    }
    if (!assignments.length) return 0;

    let target;
    const targetParams = [];
    if (recurrenceGroupId) {
      target = "recurrence_group_id = ?";
      targetParams.push(recurrenceGroupId);
    } else if (ids.length) {
      target = `id IN (${ids.map(() => "?").join(",")})`;
      targetParams.push(...ids);
    } else {
      return 0;
    }
    const scope = `${target} AND control_id = ? AND status <> 'dismissed'`;
    const [matches] = await this.pool.execute(`SELECT COUNT(*) AS count FROM transactions WHERE ${scope}`, [...targetParams, this.controlId]);
    const count = Number(matches[0]?.count || 0);
    if (!count) return 0;
    await this.pool.execute(
      `UPDATE transactions SET ${assignments.join(", ")} WHERE ${scope}`,
      [...assignmentParams, ...targetParams, this.controlId]
    );
    return count;
  }

  async confirmTransactions(inputIds, reviewedIds = []) {
    const ids = confirmationIds(inputIds);
    const userId = this.userId;
    const controlId = this.controlId;
    const reviewed = Array.isArray(reviewedIds) ? reviewedIds.filter((id) => ["string", "number"].includes(typeof id)).map(String) : [];
    const requestPool = this.requestContext.getStore()?.pool;
    const nested = Boolean(requestPool && requestPool !== this.defaultPool);
    const connection = nested ? requestPool : await this.defaultPool.getConnection();
    try {
      if (!nested) await connection.beginTransaction();
      return await this.requestContext.run({ pool: connection, userId, controlId }, async () => {
        await connection.execute("SELECT id FROM financial_controls WHERE id = ? FOR UPDATE", [controlId]);
        const [members] = await connection.execute("SELECT role FROM control_members WHERE user_id = ? AND control_id = ?", [userId, controlId]);
        if (!members.length || !["owner", "editor"].includes(members[0].role)) throw Object.assign(new Error("Você precisa ter permissão de edição para salvar lançamentos."), { status: 403 });
        const slots = ids.map(() => "?").join(", ");
        const [rows] = await connection.execute(`SELECT CAST(id AS CHAR) AS id, status FROM transactions WHERE control_id = ? AND id IN (${slots}) AND status <> 'dismissed' FOR UPDATE`, [controlId, ...ids]);
        if (rows.length !== ids.length) throw Object.assign(new Error("Um ou mais lançamentos não foram encontrados neste espaço."), { status: 404 });
        const pendingIds = rows.filter((row) => row.status === "pending").map((row) => String(row.id));
        if (pendingIds.length && unreviewedDuplicateIds(await this.read(), pendingIds, reviewed).length) {
          if (!nested) await connection.rollback();
          return { confirmedCount: 0, reviewRequired: true };
        }
        if (pendingIds.length) {
          await connection.execute(`UPDATE transactions SET status = CASE WHEN due_date IS NOT NULL THEN 'scheduled' ELSE 'confirmed' END WHERE control_id = ? AND status = 'pending' AND id IN (${slots})`, [controlId, ...ids]);
          await this.addMessage({ role: "assistant", content: pendingIds.length === 1 ? "Lançamento salvo após conferência." : `${pendingIds.length} lançamentos salvos após conferência.` });
        }
        if (!nested) await connection.commit();
        return { confirmedCount: pendingIds.length, reviewRequired: false };
      });
    } catch (error) {
      if (!nested) await connection.rollback();
      throw error;
    } finally { if (!nested) connection.release(); }
  }

  async walletsForControl(controlId, userId = this.userId) {
    const [members] = await this.pool.execute(
      "SELECT role FROM control_members WHERE user_id = ? AND control_id = ? LIMIT 1",
      [userId, controlId]
    );
    if (!members.length) throw Object.assign(new Error("Este espaço não está disponível para sua conta."), { status: 403 });
    const [wallets] = await this.pool.execute(
      "SELECT CAST(id AS CHAR) AS id, name, type FROM financial_accounts WHERE control_id = ? ORDER BY name",
      [controlId]
    );
    return wallets;
  }

  async moveTransactionsToControl({
    ids = [], destinationControlId, walletMode = "match", destinationAccountId = null, destinationAccountName = null
  }) {
    const sourceControlId = this.controlId;
    const userId = this.userId;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !["string", "number"].includes(typeof id) || (typeof id === "number" && !Number.isSafeInteger(id)))) {
      throw Object.assign(new Error("Selecione de 1 a 100 lançamentos válidos."), { status: 400 });
    }
    const transactionIds = [...new Set(ids.map(String))];
    if (!transactionIds.length || transactionIds.length > 100 || transactionIds.some((id) => !/^\d{1,20}$/.test(id))) {
      throw Object.assign(new Error("Selecione de 1 a 100 lançamentos válidos."), { status: 400 });
    }
    if (!/^\d{1,20}$/.test(String(destinationControlId || "")) || String(sourceControlId) === String(destinationControlId)) {
      throw Object.assign(new Error("Escolha outro espaço como destino."), { status: 400 });
    }

    const requestPool = this.requestContext.getStore()?.pool;
    const insideCapture = Boolean(requestPool && requestPool !== this.defaultPool);
    const connection = insideCapture ? requestPool : await this.defaultPool.getConnection();
    try {
      if (!insideCapture) await connection.beginTransaction();
      const [members] = await connection.execute(
        "SELECT control_id AS controlId, role FROM control_members WHERE user_id = ? AND control_id IN (?, ?)",
        [userId, sourceControlId, destinationControlId]
      );
      if (members.length !== 2 || members.some((member) => !["owner", "editor"].includes(member.role))) {
        throw Object.assign(new Error("Você precisa ter permissão de edição nos dois espaços para mover lançamentos."), { status: 403 });
      }
      const [destinationRows] = await connection.execute(
        "SELECT name FROM financial_controls WHERE id = ? LIMIT 1",
        [destinationControlId]
      );
      if (!destinationRows.length) throw Object.assign(new Error("O espaço de destino não foi encontrado."), { status: 404 });

      const placeholders = transactionIds.map(() => "?").join(", ");
      const selectedSql = `SELECT CAST(t.id AS CHAR) AS id, t.status, CAST(t.account_id AS CHAR) AS accountId,
          a.name AS accountName, t.recurrence_group_id AS recurrenceGroupId,
          COALESCE(c.name, 'Outros') AS categoryName, t.kind
        FROM transactions t
        LEFT JOIN financial_accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.control_id = ? AND t.status <> 'dismissed' AND t.id IN (${placeholders}) FOR UPDATE`;
      const [selectedRows] = await connection.execute(selectedSql, [sourceControlId, ...transactionIds]);
      if (selectedRows.length !== transactionIds.length) {
        throw Object.assign(new Error("Um ou mais lançamentos não foram encontrados neste espaço."), { status: 404 });
      }
      const recurrenceIds = [...new Set(selectedRows.map((row) => row.recurrenceGroupId).filter(Boolean).map(String))];
      const groupClause = recurrenceIds.length ? ` OR t.recurrence_group_id IN (${recurrenceIds.map(() => "?").join(", ")})` : "";
      const candidateSql = `SELECT CAST(t.id AS CHAR) AS id, t.status, CAST(t.account_id AS CHAR) AS accountId,
          a.name AS accountName, t.recurrence_group_id AS recurrenceGroupId,
          COALESCE(c.name, 'Outros') AS categoryName, t.kind
        FROM transactions t
        LEFT JOIN financial_accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.control_id = ? AND t.status <> 'dismissed' AND (t.id IN (${placeholders})${groupClause}) FOR UPDATE`;
      const [candidateRows] = await connection.execute(candidateSql, [sourceControlId, ...transactionIds, ...recurrenceIds]);
      const rows = expandMoveRows(candidateRows, transactionIds);
      if (rows.length > 500) throw Object.assign(new Error("A seleção inclui mais de 500 lançamentos. Divida a movimentação em grupos menores."), { status: 400 });

      const [destinationWallets] = await connection.execute(
        "SELECT CAST(id AS CHAR) AS id, name FROM financial_accounts WHERE control_id = ? ORDER BY name",
        [destinationControlId]
      );
      let specificWallet = null;
      if (walletMode === "specific") {
        specificWallet = destinationWallets.find((wallet) => String(wallet.id) === String(destinationAccountId));
        if (!specificWallet) throw Object.assign(new Error("A carteira escolhida não pertence ao espaço de destino."), { status: 400 });
      } else if (walletMode === "named") {
        const match = matchMoveWallet(destinationAccountName, destinationWallets);
        if (match.ambiguous) throw Object.assign(new Error("Há mais de uma carteira com esse nome no espaço de destino."), { status: 409 });
        if (!match.wallet) throw Object.assign(new Error(`Não encontrei a carteira “${destinationAccountName}” no espaço de destino.`), { status: 404 });
        specificWallet = match.wallet;
      } else if (!new Set(["match", "none"]).has(walletMode)) {
        throw Object.assign(new Error("A opção de carteira é inválida."), { status: 400 });
      }

      const categoryIds = new Map();
      let unassignedWalletCount = 0;
      for (const row of rows) {
        const categoryKey = `${row.kind}:${normalizeMoveName(row.categoryName)}`;
        let categoryId = categoryIds.get(categoryKey);
        if (!categoryId) {
          const [existingCategories] = await connection.execute(
            "SELECT id FROM categories WHERE control_id = ? AND name = ? AND kind = ? LIMIT 1",
            [destinationControlId, row.categoryName || "Outros", row.kind]
          );
          if (existingCategories.length) categoryId = existingCategories[0].id;
          else {
            await connection.execute(
              "INSERT IGNORE INTO categories (control_id, user_id, name, kind) VALUES (?, ?, ?, ?)",
              [destinationControlId, userId, row.categoryName || "Outros", row.kind]
            );
            const [createdCategories] = await connection.execute(
              "SELECT id FROM categories WHERE control_id = ? AND name = ? AND kind = ? LIMIT 1",
              [destinationControlId, row.categoryName || "Outros", row.kind]
            );
            categoryId = createdCategories[0]?.id;
          }
          if (!categoryId) throw Object.assign(new Error("Não consegui preparar as categorias no espaço de destino."), { status: 500 });
          categoryIds.set(categoryKey, categoryId);
        }

        let accountId = null;
        if (walletMode === "specific" || walletMode === "named") accountId = specificWallet.id;
        else if (walletMode === "match" && row.accountId) {
          const match = matchMoveWallet(row.accountName, destinationWallets);
          accountId = match.wallet?.id || null;
          if (!accountId) unassignedWalletCount += 1;
        }
        const [updated] = await connection.execute(
          "UPDATE transactions SET control_id = ?, account_id = ?, category_id = ? WHERE id = ? AND control_id = ? AND status <> 'dismissed'",
          [destinationControlId, accountId, categoryId, row.id, sourceControlId]
        );
        if (Number(updated.affectedRows) !== 1) throw Object.assign(new Error("Um lançamento mudou durante a transferência. Nada foi movido; atualize a tela e tente novamente."), { status: 409 });
      }

      const [linkedDocuments] = await connection.execute(
        `SELECT DISTINCT CAST(document_id AS CHAR) AS documentId FROM transaction_documents WHERE transaction_id IN (${rows.map(() => "?").join(", ")})`,
        rows.map((row) => String(row.id))
      );
      const documentIds = new Set();
      for (const document of linkedDocuments) {
        const [remaining] = await connection.execute(
          `SELECT t.id FROM transactions t INNER JOIN transaction_documents td ON td.transaction_id = t.id WHERE td.document_id = ? AND t.status <> 'dismissed' AND t.control_id <> ? LIMIT 1`,
          [document.documentId, destinationControlId]
        );
        if (!remaining.length) documentIds.add(document.documentId);
      }
      let movedDocumentCount = 0;
      if (documentIds.size) {
        const documentPlaceholders = [...documentIds].map(() => "?").join(", ");
        const [movedDocuments] = await connection.execute(
          `UPDATE documents SET control_id = ? WHERE control_id = ? AND id IN (${documentPlaceholders})`,
          [destinationControlId, sourceControlId, ...documentIds]
        );
        movedDocumentCount = Number(movedDocuments.affectedRows || 0);
      }

      if (!insideCapture) await connection.commit();
      return {
        movedCount: rows.length,
        movedDocumentCount,
        unassignedWalletCount,
        destinationName: destinationRows[0].name
      };
    } catch (error) {
      if (!insideCapture) await connection.rollback();
      throw error;
    } finally {
      if (!insideCapture) connection.release();
    }
  }

  async addDocument(document) {
    const [result] = await this.pool.execute(
      `INSERT INTO documents (control_id, user_id, original_name, stored_name, mime_type, status, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.controlId, this.userId, document.originalName, document.storedName, document.mimeType, document.status, document.contentHash || null]
    );

    return { id: String(result.insertId), createdAt: new Date().toISOString(), ...document };
  }

  async linkTransactionDocument(transactionId, documentId) {
    await this.pool.execute(
      `INSERT IGNORE INTO transaction_documents (transaction_id, document_id)
       SELECT t.id, d.id FROM transactions t INNER JOIN documents d ON d.id = ? AND d.control_id = t.control_id WHERE t.id = ? AND t.control_id = ?`,
      [documentId, transactionId, this.controlId]
    );
  }

  async backfillDocumentLinks() {
    const [receipts] = await this.pool.execute("SELECT capture_data FROM capture_requests WHERE operation = 'upload' AND capture_data IS NOT NULL AND JSON_VALID(capture_data)");
    for (const receipt of receipts) {
      let capture;
      try { capture = JSON.parse(receipt.capture_data); } catch { continue; }
      const documentId = String(capture?.documentId || "");
      const ids = Array.isArray(capture?.transactionIds) ? [...new Set(capture.transactionIds.map(String))].filter((id) => /^\d{1,20}$/.test(id)) : [];
      if (!/^\d{1,20}$/.test(documentId) || !ids.length) continue;
      await this.pool.execute(
        `INSERT IGNORE INTO transaction_documents (transaction_id, document_id) SELECT t.id, d.id FROM transactions t INNER JOIN documents d ON d.id = ? AND d.control_id = t.control_id WHERE t.id IN (${ids.map(() => "?").join(", ")})`,
        [documentId, ...ids]
      );
    }
  }

  async updateDocumentStatus(id, status) {
    await this.pool.execute(
      `UPDATE documents SET status = ? WHERE id = ? AND user_id = ? AND control_id = ?`,
      [status, id, this.userId, this.controlId]
    );
    return { id: String(id), status };
  }

  async updateDocumentName(id, originalName) {
    await this.pool.execute(
      `UPDATE documents SET original_name = ? WHERE id = ? AND user_id = ? AND control_id = ?`,
      [originalName, id, this.userId, this.controlId]
    );
    return { id: String(id), originalName };
  }

  async ensureSchema() {
    await this.pool.execute(`CREATE TABLE IF NOT EXISTS capture_requests (
      user_id BIGINT UNSIGNED NOT NULL,
      control_id BIGINT UNSIGNED NOT NULL,
      request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      operation VARCHAR(20) NOT NULL,
      fingerprint CHAR(64) CHARACTER SET ascii NOT NULL,
      capture_data LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, control_id, request_key)
    ) ENGINE=InnoDB`);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(180) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS financial_controls (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        owner_user_id BIGINT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_controls_owner (owner_user_id)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS control_members (
        control_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role ENUM('owner', 'editor', 'viewer') NOT NULL DEFAULT 'editor',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (control_id, user_id),
        INDEX idx_members_user (user_id)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        active_control_id BIGINT UNSIGNED NULL,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sessions_user (user_id),
        INDEX idx_sessions_expires (expires_at)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reset_user (user_id),
        INDEX idx_reset_expires (expires_at)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        kind ENUM('income', 'expense') NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_categories_control_name_kind (control_id, name, kind)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS financial_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        type ENUM('checking', 'savings', 'cash', 'credit_card', 'investment') NOT NULL,
        opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        account_id BIGINT UNSIGNED NULL,
        recurrence_group_id VARCHAR(64) NULL,
        recurrence_index SMALLINT UNSIGNED NULL,
        recurrence_total SMALLINT UNSIGNED NULL,
        category_id BIGINT UNSIGNED NULL,
        kind ENUM('income', 'expense', 'transfer') NOT NULL,
        status ENUM('confirmed', 'pending', 'paid', 'scheduled') NOT NULL DEFAULT 'confirmed',
        amount DECIMAL(14,2) NOT NULL,
        description VARCHAR(255) NOT NULL,
        merchant VARCHAR(180) NULL,
        payment_method VARCHAR(80) NULL,
        transaction_date DATE NOT NULL,
        due_date DATE NULL,
        source ENUM('chat', 'upload', 'manual', 'import') NOT NULL DEFAULT 'chat',
        raw_text TEXT NULL,
        confidence DECIMAL(5,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id),
        CONSTRAINT fk_transactions_account FOREIGN KEY (account_id) REFERENCES financial_accounts(id),
        CONSTRAINT fk_transactions_category FOREIGN KEY (category_id) REFERENCES categories(id),
        INDEX idx_transactions_user_date (user_id, transaction_date),
        INDEX idx_transactions_due_date (user_id, due_date),
        INDEX idx_transactions_kind_status (user_id, kind, status)
      )
    `);

    await this.pool.execute(`
      ALTER TABLE transactions
      MODIFY status ENUM('confirmed', 'pending', 'paid', 'scheduled', 'dismissed') NOT NULL DEFAULT 'confirmed'
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS documents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        status ENUM('uploaded', 'ocr_pending', 'review_pending', 'processed', 'failed') NOT NULL DEFAULT 'uploaded',
        extracted_text MEDIUMTEXT NULL,
        summary_json JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_documents_user FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role ENUM('user', 'assistant', 'system') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_chat_user FOREIGN KEY (user_id) REFERENCES users(id),
        INDEX idx_chat_user_created (user_id, created_at)
      )
    `);

    await this.addColumnIfMissing("categories", "control_id", "BIGINT UNSIGNED NULL AFTER id");
    await this.addColumnIfMissing("financial_accounts", "control_id", "BIGINT UNSIGNED NULL AFTER id");
    await this.addColumnIfMissing("transactions", "control_id", "BIGINT UNSIGNED NULL AFTER id");
    await this.addColumnIfMissing("transactions", "recurrence_group_id", "VARCHAR(64) NULL AFTER account_id");
    await this.addColumnIfMissing("transactions", "recurrence_index", "SMALLINT UNSIGNED NULL AFTER recurrence_group_id");
    await this.addColumnIfMissing("transactions", "recurrence_total", "SMALLINT UNSIGNED NULL AFTER recurrence_index");
    await this.addColumnIfMissing("documents", "control_id", "BIGINT UNSIGNED NULL AFTER id");
    await this.addColumnIfMissing("chat_messages", "control_id", "BIGINT UNSIGNED NULL AFTER id");
    await this.migrateDefaultControl();
    await this.ensureCategoryUniqueIndex();
    await this.backfillRecurringGroups();
    await this.ensureReviewSchema();
  }

  async ensureReviewSchema() {
    await this.pool.execute("CREATE TABLE IF NOT EXISTS finup_schema_versions (version VARCHAR(80) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    const connection = await this.defaultPool.getConnection();
    const context = { pool: connection, userId: this.userId, controlId: this.controlId };
    let locked = false;
    try {
      const [lock] = await connection.execute("SELECT GET_LOCK(CONCAT('finup-schema-', SHA1(DATABASE())), 15) AS acquired");
      locked = Number(lock[0]?.acquired) === 1;
      if (!locked) throw new Error("A atualização do banco ainda está em andamento.");
      await this.requestContext.run(context, async () => {
        const version = "20261119_smart_review_v2";
        const [applied] = await connection.execute("SELECT 1 FROM finup_schema_versions WHERE version = ?", [version]);
        if (applied.length) return;
        await this.addColumnIfMissing("documents", "content_hash", "CHAR(64) CHARACTER SET ascii NULL AFTER mime_type");
        await connection.execute(`CREATE TABLE IF NOT EXISTS transaction_documents (
          transaction_id BIGINT UNSIGNED NOT NULL, document_id BIGINT UNSIGNED NOT NULL,
          PRIMARY KEY (transaction_id, document_id), INDEX idx_transaction_documents_document (document_id),
          CONSTRAINT fk_transaction_documents_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
          CONSTRAINT fk_transaction_documents_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        ) ENGINE=InnoDB`);
        await this.backfillDocumentLinks();
        await connection.execute("INSERT IGNORE INTO finup_schema_versions (version) VALUES (?)", [version]);
      });
    } finally {
      try { if (locked) await connection.execute("SELECT RELEASE_LOCK(CONCAT('finup-schema-', SHA1(DATABASE())))"); }
      finally { connection.release(); }
    }
  }

  async addColumnIfMissing(table, column, definition) {
    try {
      await this.pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!String(error.message).includes("Duplicate column")) throw error;
    }
  }

  async migrateDefaultControl() {
    const userId = await this.ensureDefaultUser();
    const controlId = await this.ensureDefaultControl(userId);
    for (const table of ["categories", "transactions", "documents", "chat_messages"]) {
      await this.pool.execute(`UPDATE ${table} SET control_id = ? WHERE control_id IS NULL`, [controlId]);
    }
    await this.pool.execute(`UPDATE financial_accounts SET control_id = ? WHERE control_id IS NULL AND user_id = ?`, [controlId, userId]);
    await this.pool.execute(`UPDATE financial_accounts a
      INNER JOIN (SELECT user_id, MIN(control_id) AS control_id FROM control_members GROUP BY user_id) m ON m.user_id = a.user_id
      SET a.control_id = m.control_id WHERE a.control_id IS NULL`);
  }

  async ensureCategoryUniqueIndex() {
    try {
      await this.pool.execute(`ALTER TABLE categories DROP INDEX uq_categories_user_name_kind`);
    } catch (error) {
      if (!String(error.message).includes("check that")) throw error;
    }
    try {
      await this.pool.execute(`ALTER TABLE categories ADD UNIQUE KEY uq_categories_control_name_kind (control_id, name, kind)`);
    } catch (error) {
      if (String(error.message).includes("Duplicate entry")) {
        await this.dedupeCategories();
        await this.pool.execute(`ALTER TABLE categories ADD UNIQUE KEY uq_categories_control_name_kind (control_id, name, kind)`);
        return;
      }
      if (!String(error.message).includes("Duplicate key name")) throw error;
    }
  }

  async dedupeCategories() {
    await this.pool.execute(`
      UPDATE transactions t
      INNER JOIN categories c ON c.id = t.category_id
      INNER JOIN (
        SELECT MIN(id) AS keep_id, control_id, name, kind
        FROM categories
        GROUP BY control_id, name, kind
      ) keeper ON keeper.control_id <=> c.control_id AND keeper.name = c.name AND keeper.kind = c.kind
      SET t.category_id = keeper.keep_id
      WHERE c.id <> keeper.keep_id
    `);
    await this.pool.execute(`
      DELETE c FROM categories c
      INNER JOIN (
        SELECT MIN(id) AS keep_id, control_id, name, kind
        FROM categories
        GROUP BY control_id, name, kind
      ) keeper ON keeper.control_id <=> c.control_id AND keeper.name = c.name AND keeper.kind = c.kind
      WHERE c.id <> keeper.keep_id
    `);
  }

  async backfillRecurringGroups() {
    const [rows] = await this.pool.execute(`SELECT CAST(id AS CHAR) AS id, control_id AS controlId,
        description, CAST(amount AS CHAR) AS amount, kind, category_id AS categoryId
      FROM transactions
      WHERE recurrence_group_id IS NULL AND description REGEXP ' [(][0-9]+/[0-9]+[)]$'
      ORDER BY control_id, id`);
    const groups = new Map();

    for (const row of rows) {
      const match = String(row.description).match(/^(.*) \((\d+)\/(\d+)\)$/);
      if (!match) continue;
      const [, description, indexText, totalText] = match;
      const index = Number(indexText);
      const total = Number(totalText);
      if (total < 2 || total > 60 || index < 1 || index > total) continue;
      const key = JSON.stringify([row.controlId, description, row.amount, row.kind, row.categoryId, total]);
      const group = groups.get(key) || { rows: [], indexes: new Set(), total };
      group.rows.push({ id: row.id, index });
      group.indexes.add(index);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      if (group.rows.length !== group.total || group.indexes.size !== group.total) continue;
      if (Array.from({ length: group.total }, (_, index) => index + 1).some((index) => !group.indexes.has(index))) continue;
      const groupId = `legacy-${group.rows[0].id}`;
      for (const row of group.rows) {
        await this.pool.execute(`UPDATE transactions
          SET recurrence_group_id = ?, recurrence_index = ?, recurrence_total = ?
          WHERE id = ? AND recurrence_group_id IS NULL`, [groupId, row.index, group.total, row.id]);
      }
    }
  }

  async ensureDefaultUser() {
    await this.pool.execute(
      `INSERT IGNORE INTO users (name, email) VALUES (?, ?)`,
      [defaultUser.name, defaultUser.email]
    );
    const [rows] = await this.pool.execute(`SELECT id FROM users WHERE email = ? LIMIT 1`, [defaultUser.email]);
    return rows[0].id;
  }

  async ensureDefaultControl(userId) {
    const [existing] = await this.pool.execute(
      `SELECT id FROM financial_controls WHERE owner_user_id = ? ORDER BY id LIMIT 1`,
      [userId]
    );
    if (existing[0]?.id) {
      await this.pool.execute(
        `INSERT IGNORE INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)`,
        [existing[0].id, userId, "owner"]
      );
      return existing[0].id;
    }
    const [result] = await this.pool.execute(
      `INSERT INTO financial_controls (name, owner_user_id) VALUES (?, ?)`,
      ["Meu controle financeiro", userId]
    );
    await this.pool.execute(
      `INSERT INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)`,
      [result.insertId, userId, "owner"]
    );
    return result.insertId;
  }

  async ensureWelcomeMessage() {
    const [rows] = await this.pool.execute(
      `SELECT id FROM chat_messages WHERE control_id = ? LIMIT 1`,
      [this.controlId]
    );
    if (rows.length) return;
    await this.addMessage({ role: "assistant", content: welcomeMessage });
  }

  async ensureCategory(name, kind) {
    const categoryKind = kind === "income" ? "income" : "expense";
    await this.pool.execute(
      `INSERT IGNORE INTO categories (control_id, user_id, name, kind) VALUES (?, ?, ?, ?)`,
      [this.controlId, this.userId, name || "Outros", categoryKind]
    );
    const [rows] = await this.pool.execute(
      `SELECT id FROM categories WHERE control_id = ? AND name = ? AND kind = ? LIMIT 1`,
      [this.controlId, name || "Outros", categoryKind]
    );
    return rows[0].id;
  }
}

function normalizeTransaction(row) {
  return {
    ...normalizeDates(row),
    transactionDate: toIsoDate(row.transactionDate),
    dueDate: row.dueDate ? toIsoDate(row.dueDate) : null,
    amount: Number(row.amount),
    confidence: Number(row.confidence)
  };
}

function normalizeDates(row) {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString()
  };
}

function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
