CREATE TEMPORARY TABLE financial_controls (
  id BIGINT UNSIGNED PRIMARY KEY, name VARCHAR(160) NOT NULL
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE control_members (
  control_id BIGINT UNSIGNED, user_id BIGINT UNSIGNED, role VARCHAR(20),
  PRIMARY KEY (control_id, user_id)
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE financial_accounts (
  id BIGINT UNSIGNED PRIMARY KEY, control_id BIGINT UNSIGNED, name VARCHAR(160), type VARCHAR(30), opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, control_id BIGINT UNSIGNED, user_id BIGINT UNSIGNED,
  name VARCHAR(160), kind VARCHAR(20), UNIQUE KEY (control_id, name, kind)
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE transactions (
  id BIGINT UNSIGNED PRIMARY KEY, control_id BIGINT UNSIGNED, user_id BIGINT UNSIGNED,
  account_id BIGINT UNSIGNED NULL, category_id BIGINT UNSIGNED, kind VARCHAR(20), status VARCHAR(20),
  description VARCHAR(160), amount DECIMAL(12,2), transaction_date DATE, due_date DATE NULL,
  recurrence_group_id VARCHAR(64) NULL, recurrence_index INT NULL, recurrence_total INT NULL,
  merchant VARCHAR(180) NULL, payment_method VARCHAR(80) NULL, source VARCHAR(20) NOT NULL DEFAULT 'chat',
  raw_text TEXT NULL, confidence DECIMAL(5,2) NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE documents (
  id BIGINT UNSIGNED PRIMARY KEY, control_id BIGINT UNSIGNED, user_id BIGINT UNSIGNED,
  original_name VARCHAR(255), stored_name VARCHAR(255), mime_type VARCHAR(120) NOT NULL DEFAULT 'application/pdf',
  content_hash CHAR(64) NULL, status VARCHAR(30) NOT NULL DEFAULT 'processed', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE transaction_documents (
  transaction_id BIGINT UNSIGNED, document_id BIGINT UNSIGNED, PRIMARY KEY (transaction_id, document_id)
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE chat_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED, control_id BIGINT UNSIGNED,
  role VARCHAR(20), content TEXT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TEMPORARY TABLE capture_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, control_id BIGINT UNSIGNED, user_id BIGINT UNSIGNED,
  operation VARCHAR(30), capture_data LONGTEXT
) ENGINE=InnoDB;

INSERT INTO financial_controls VALUES (1, 'Royal Face'), (2, 'Casa'), (3, 'Somente leitura'), (4, 'Sem acesso');
INSERT INTO control_members VALUES (1, 1, 'owner'), (2, 1, 'editor'), (3, 1, 'viewer'), (1, 2, 'viewer'), (2, 2, 'editor');
INSERT INTO financial_accounts (id, control_id, name, type) VALUES (11, 1, 'Nubank', 'checking'), (12, 1, 'Conta empresarial', 'checking'), (21, 2, 'Nubank', 'checking'), (22, 2, 'Dinheiro', 'cash');
INSERT INTO categories (id, control_id, user_id, name, kind) VALUES (11, 1, 1, 'Educação', 'expense'), (12, 1, 1, 'Mercado', 'expense'), (21, 2, 1, 'Educação', 'expense');
INSERT INTO transactions (id, control_id, user_id, account_id, category_id, kind, status, description, amount, transaction_date, due_date, recurrence_group_id, recurrence_index, recurrence_total) VALUES
  (101, 1, 1, 11, 11, 'expense', 'paid', 'Escola (1/2)', 900, '2026-11-10', '2026-11-10', 'school-fee', 1, 2),
  (102, 1, 1, 11, 11, 'expense', 'scheduled', 'Escola (2/2)', 900, '2026-12-10', '2026-12-10', 'school-fee', 2, 2),
  (103, 1, 1, 12, 12, 'expense', 'confirmed', 'Mercado', 100, '2026-11-10', NULL, NULL, NULL, NULL),
  (104, 1, 1, NULL, 12, 'expense', 'pending', 'Outro item', 50, '2026-11-10', NULL, NULL, NULL, NULL),
  (105, 4, 3, NULL, NULL, 'expense', 'scheduled', 'Outro espaço', 500, '2026-12-10', '2026-12-10', 'school-fee', 1, 2);
INSERT INTO documents (id, control_id, user_id, original_name, stored_name) VALUES (201, 1, 1, 'Escola.pdf', 'gs://test/controls/1/school.pdf'), (202, 1, 1, 'Itens.pdf', 'gs://test/controls/1/items.pdf');
INSERT INTO transaction_documents VALUES (101,201), (102,201), (103,202), (104,202);
INSERT INTO capture_requests (control_id, user_id, operation, capture_data) VALUES
  (1, 1, 'upload', '{"transactionIds":["101","102"],"documentId":"201"}'),
  (1, 1, 'upload', '{"transactionIds":["103","104"],"documentId":"202"}');
