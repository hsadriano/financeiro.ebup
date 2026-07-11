const defaultUser = {
  name: "Usuario principal",
  email: "usuario@local"
};

const welcomeMessage =
  "Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload.";

export class MariaDbStorage {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.userId = null;
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
    await this.ensureWelcomeMessage();
  }

  async read() {
    const [messages] = await this.pool.execute(
      `SELECT CAST(id AS CHAR) AS id, role, content, created_at AS createdAt
       FROM chat_messages
       WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
      [this.userId]
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
         t.transaction_date AS transactionDate,
         t.due_date AS dueDate,
         COALESCE(c.name, 'Outros') AS category,
         t.source,
         t.raw_text AS rawText,
         t.confidence,
         t.created_at AS createdAt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC, t.id DESC`,
      [this.userId]
    );

    const [documents] = await this.pool.execute(
      `SELECT
         CAST(id AS CHAR) AS id,
         original_name AS originalName,
         stored_name AS storedName,
         mime_type AS mimeType,
         status,
         created_at AS createdAt
       FROM documents
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`,
      [this.userId]
    );

    return {
      messages: messages.map(normalizeDates),
      transactions: transactions.map(normalizeTransaction),
      documents: documents.map(normalizeDates)
    };
  }

  async addMessage(message) {
    const [result] = await this.pool.execute(
      `INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)`,
      [this.userId, message.role, message.content]
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
         user_id, category_id, kind, status, amount, description, merchant, payment_method,
         transaction_date, due_date, source, raw_text, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.userId,
        categoryId,
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
      `UPDATE transactions SET status = ? WHERE id = ? AND user_id = ?`,
      [status, id, this.userId]
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
         t.transaction_date AS transactionDate,
         t.due_date AS dueDate,
         COALESCE(c.name, 'Outros') AS category,
         t.source,
         t.raw_text AS rawText,
         t.confidence,
         t.created_at AS createdAt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.id = ? AND t.user_id = ?
       LIMIT 1`,
      [id, this.userId]
    );
    return rows[0] ? normalizeTransaction(rows[0]) : null;
  }

  async addDocument(document) {
    const [result] = await this.pool.execute(
      `INSERT INTO documents (user_id, original_name, stored_name, mime_type, status)
       VALUES (?, ?, ?, ?, ?)`,
      [this.userId, document.originalName, document.storedName, document.mimeType, document.status]
    );

    return { id: String(result.insertId), createdAt: new Date().toISOString(), ...document };
  }

  async ensureSchema() {
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
      CREATE TABLE IF NOT EXISTS categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        kind ENUM('income', 'expense') NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_categories_user_name_kind (user_id, name, kind)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS financial_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
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
        user_id BIGINT UNSIGNED NOT NULL,
        account_id BIGINT UNSIGNED NULL,
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
        user_id BIGINT UNSIGNED NOT NULL,
        role ENUM('user', 'assistant', 'system') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_chat_user FOREIGN KEY (user_id) REFERENCES users(id),
        INDEX idx_chat_user_created (user_id, created_at)
      )
    `);
  }

  async ensureDefaultUser() {
    await this.pool.execute(
      `INSERT IGNORE INTO users (name, email) VALUES (?, ?)`,
      [defaultUser.name, defaultUser.email]
    );
    const [rows] = await this.pool.execute(`SELECT id FROM users WHERE email = ? LIMIT 1`, [defaultUser.email]);
    return rows[0].id;
  }

  async ensureWelcomeMessage() {
    const [rows] = await this.pool.execute(
      `SELECT id FROM chat_messages WHERE user_id = ? LIMIT 1`,
      [this.userId]
    );
    if (rows.length) return;
    await this.addMessage({ role: "assistant", content: welcomeMessage });
  }

  async ensureCategory(name, kind) {
    const categoryKind = kind === "income" ? "income" : "expense";
    await this.pool.execute(
      `INSERT IGNORE INTO categories (user_id, name, kind) VALUES (?, ?, ?)`,
      [this.userId, name || "Outros", categoryKind]
    );
    const [rows] = await this.pool.execute(
      `SELECT id FROM categories WHERE user_id = ? AND name = ? AND kind = ? LIMIT 1`,
      [this.userId, name || "Outros", categoryKind]
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
