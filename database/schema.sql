CREATE DATABASE IF NOT EXISTS finance_assistant
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE finance_assistant;

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financial_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  type ENUM('checking', 'savings', 'cash', 'credit_card', 'investment') NOT NULL,
  opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  name VARCHAR(120) NOT NULL,
  kind ENUM('income', 'expense') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NULL,
  category_id BIGINT UNSIGNED NULL,
  kind ENUM('income', 'expense', 'transfer') NOT NULL,
  status ENUM('confirmed', 'pending', 'paid', 'scheduled', 'dismissed') NOT NULL DEFAULT 'confirmed',
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
);

CREATE TABLE documents (
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
);

CREATE TABLE chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'assistant', 'system') NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chat_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_chat_user_created (user_id, created_at)
);
