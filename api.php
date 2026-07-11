<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

try {
    $env = load_env(__DIR__ . '/.env');
    $pdo = connect_db($env);
    ensure_schema($pdo);
    $userId = ensure_default_user($pdo);
    ensure_welcome_message($pdo, $userId);

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = trim((string)($_GET['path'] ?? ''), '/');

    if ($method === 'GET' && $path === 'state') {
        respond(build_state(read_data($pdo, $userId)));
    }

    if ($method === 'POST' && $path === 'chat') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $message = trim((string)($body['message'] ?? ''));
        if ($message === '') {
            respond(['error' => 'Mensagem vazia'], 400);
        }

        add_message($pdo, $userId, 'user', $message);
        $parsed = parse_financial_message($message, $env);

        if ($parsed['intent'] === 'transaction') {
            $transaction = $parsed['transaction'];
            $transaction['status'] = 'pending';
            $saved = add_transaction($pdo, $userId, $transaction);
            $assistant = summarize_transaction($saved) . ' Confira os dados e confirme para salvar nos relatorios.';
        } else {
            $assistant = $parsed['answer'];
        }

        add_message($pdo, $userId, 'assistant', $assistant);
        respond(build_state(read_data($pdo, $userId)));
    }

    if ($method === 'POST' && preg_match('#^transactions/([^/]+)/(confirm|dismiss|update)$#', $path, $matches)) {
        if ($matches[2] === 'update') {
            $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
            $updated = update_transaction($pdo, $userId, $matches[1], normalize_transaction_changes($body));
            if (!$updated) {
                respond(['error' => 'Lancamento nao encontrado'], 404);
            }
            respond(build_state(read_data($pdo, $userId)));
        }

        $status = $matches[2] === 'confirm' ? 'confirmed' : 'dismissed';
        $updated = update_transaction_status($pdo, $userId, $matches[1], $status);
        if (!$updated) {
            respond(['error' => 'Lancamento nao encontrado'], 404);
        }

        $verb = $matches[2] === 'confirm' ? 'confirmado' : 'descartado';
        add_message($pdo, $userId, 'assistant', "Lancamento {$verb}: {$updated['description']}");
        respond(build_state(read_data($pdo, $userId)));
    }

    if ($method === 'POST' && $path === 'upload') {
        if (!isset($_FILES['file'])) {
            respond(['error' => 'Nenhum arquivo enviado'], 400);
        }

        $uploadDir = __DIR__ . '/uploads';
        if (!is_dir($uploadDir)) {
            mkdir($uploadDir, 0755, true);
        }

        $file = $_FILES['file'];
        $originalName = basename((string)$file['name']);
        $extension = pathinfo($originalName, PATHINFO_EXTENSION);
        $storedName = time() . '-' . bin2hex(random_bytes(12)) . ($extension ? ".{$extension}" : '.bin');
        $target = "{$uploadDir}/{$storedName}";

        if (!move_uploaded_file((string)$file['tmp_name'], $target)) {
            respond(['error' => 'Falha ao salvar upload'], 500);
        }

        add_document($pdo, $userId, [
            'originalName' => $originalName,
            'storedName' => $storedName,
            'mimeType' => (string)($file['type'] ?: 'application/octet-stream'),
            'status' => 'ocr_pending',
        ]);

        add_message(
            $pdo,
            $userId,
            'assistant',
            "Recebi o arquivo \"{$originalName}\". Ele entrou na fila de OCR; na proxima etapa vamos extrair valor, vencimento, beneficiario e categoria automaticamente."
        );
        respond(build_state(read_data($pdo, $userId)));
    }

    respond(['error' => 'Not found'], 404);
} catch (Throwable $error) {
    respond(['error' => 'Erro interno', 'detail' => $error->getMessage()], 500);
}

function load_env(string $path): array
{
    $env = [];
    if (!is_file($path)) {
        return $env;
    }

    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $env[trim($key)] = trim($value);
    }
    return $env;
}

function connect_db(array $env): PDO
{
    $host = $env['DB_HOST'] ?? 'localhost';
    $port = $env['DB_PORT'] ?? '3306';
    $name = $env['DB_NAME'] ?? '';
    $user = $env['DB_USER'] ?? '';
    $pass = $env['DB_PASS'] ?? '';

    if ($name === '' || $user === '') {
        throw new RuntimeException('DB_NAME e DB_USER precisam estar configurados no .env.');
    }

    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
    return new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
}

function ensure_schema(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(180) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        kind ENUM('income', 'expense') NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_categories_user_name_kind (user_id, name, kind)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        type ENUM('checking', 'savings', 'cash', 'credit_card', 'investment') NOT NULL,
        opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS transactions (
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
        INDEX idx_transactions_user_date (user_id, transaction_date),
        INDEX idx_transactions_due_date (user_id, due_date),
        INDEX idx_transactions_kind_status (user_id, kind, status)
    )");

    $pdo->exec("ALTER TABLE transactions
        MODIFY status ENUM('confirmed', 'pending', 'paid', 'scheduled', 'dismissed') NOT NULL DEFAULT 'confirmed'");

    $pdo->exec("CREATE TABLE IF NOT EXISTS documents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        status ENUM('uploaded', 'ocr_pending', 'review_pending', 'processed', 'failed') NOT NULL DEFAULT 'uploaded',
        extracted_text MEDIUMTEXT NULL,
        summary_json JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        role ENUM('user', 'assistant', 'system') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chat_user_created (user_id, created_at)
    )");
}

function ensure_default_user(PDO $pdo): int
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO users (name, email) VALUES (?, ?)');
    $stmt->execute(['Usuario principal', 'usuario@local']);
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $stmt->execute(['usuario@local']);
    return (int)$stmt->fetchColumn();
}

function ensure_welcome_message(PDO $pdo, int $userId): void
{
    $stmt = $pdo->prepare('SELECT id FROM chat_messages WHERE user_id = ? LIMIT 1');
    $stmt->execute([$userId]);
    if ($stmt->fetchColumn()) {
        return;
    }
    add_message($pdo, $userId, 'assistant', 'Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload.');
}

function read_data(PDO $pdo, int $userId): array
{
    $stmt = $pdo->prepare('SELECT CAST(id AS CHAR) AS id, role, content, created_at AS createdAt FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC, id ASC');
    $stmt->execute([$userId]);
    $messages = array_map('normalize_dates', $stmt->fetchAll());

    $stmt = $pdo->prepare("SELECT
        CAST(t.id AS CHAR) AS id,
        t.kind,
        t.status,
        CAST(t.amount AS DECIMAL(14,2)) AS amount,
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
        ORDER BY t.created_at DESC, t.id DESC");
    $stmt->execute([$userId]);
    $transactions = array_map('normalize_transaction', $stmt->fetchAll());

    $stmt = $pdo->prepare('SELECT CAST(id AS CHAR) AS id, original_name AS originalName, stored_name AS storedName, mime_type AS mimeType, status, created_at AS createdAt FROM documents WHERE user_id = ? ORDER BY created_at DESC, id DESC');
    $stmt->execute([$userId]);
    $documents = array_map('normalize_dates', $stmt->fetchAll());

    return compact('messages', 'transactions', 'documents');
}

function add_message(PDO $pdo, int $userId, string $role, string $content): void
{
    $stmt = $pdo->prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)');
    $stmt->execute([$userId, $role, $content]);
}

function add_transaction(PDO $pdo, int $userId, array $transaction): array
{
    $categoryId = ensure_category($pdo, $userId, $transaction['category'], $transaction['kind']);
    $stmt = $pdo->prepare('INSERT INTO transactions (
        user_id, category_id, kind, status, amount, description, merchant, payment_method,
        transaction_date, due_date, source, raw_text, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $userId,
        $categoryId,
        $transaction['kind'],
        $transaction['status'],
        $transaction['amount'],
        $transaction['description'],
        $transaction['merchant'],
        $transaction['paymentMethod'],
        $transaction['transactionDate'],
        $transaction['dueDate'],
        $transaction['source'],
        $transaction['rawText'],
        $transaction['confidence'],
    ]);
    $transaction['id'] = (string)$pdo->lastInsertId();
    $transaction['createdAt'] = gmdate('c');
    return $transaction;
}

function add_document(PDO $pdo, int $userId, array $document): void
{
    $stmt = $pdo->prepare('INSERT INTO documents (user_id, original_name, stored_name, mime_type, status) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$userId, $document['originalName'], $document['storedName'], $document['mimeType'], $document['status']]);
}

function update_transaction_status(PDO $pdo, int $userId, string $id, string $status): ?array
{
    $stmt = $pdo->prepare('UPDATE transactions SET status = ? WHERE id = ? AND user_id = ?');
    $stmt->execute([$status, $id, $userId]);
    $data = read_data($pdo, $userId);
    foreach ($data['transactions'] as $transaction) {
        if ($transaction['id'] === $id) {
            return $transaction;
        }
    }
    return null;
}

function update_transaction(PDO $pdo, int $userId, string $id, array $changes): ?array
{
    $categoryId = ensure_category($pdo, $userId, $changes['category'], $changes['kind']);
    $stmt = $pdo->prepare('UPDATE transactions
        SET kind = ?,
            category_id = ?,
            amount = ?,
            description = ?,
            merchant = ?,
            payment_method = ?,
            transaction_date = ?,
            due_date = ?
        WHERE id = ? AND user_id = ? AND status = ?');
    $stmt->execute([
        $changes['kind'],
        $categoryId,
        $changes['amount'],
        $changes['description'],
        $changes['merchant'],
        $changes['paymentMethod'],
        $changes['transactionDate'],
        $changes['dueDate'],
        $id,
        $userId,
        'pending',
    ]);

    $data = read_data($pdo, $userId);
    foreach ($data['transactions'] as $transaction) {
        if ($transaction['id'] === $id) {
            return $transaction;
        }
    }
    return null;
}

function ensure_category(PDO $pdo, int $userId, string $name, string $kind): int
{
    $categoryKind = $kind === 'income' ? 'income' : 'expense';
    $stmt = $pdo->prepare('INSERT IGNORE INTO categories (user_id, name, kind) VALUES (?, ?, ?)');
    $stmt->execute([$userId, $name ?: 'Outros', $categoryKind]);
    $stmt = $pdo->prepare('SELECT id FROM categories WHERE user_id = ? AND name = ? AND kind = ? LIMIT 1');
    $stmt->execute([$userId, $name ?: 'Outros', $categoryKind]);
    return (int)$stmt->fetchColumn();
}

function build_state(array $data): array
{
    $month = date('Y-m');
    $confirmed = array_values(array_filter($data['transactions'], fn($item) => in_array($item['status'], ['confirmed', 'paid', 'scheduled'], true)));
    $pending = array_values(array_filter($data['transactions'], fn($item) => $item['status'] === 'pending'));
    $monthTransactions = array_values(array_filter($confirmed, fn($item) => str_starts_with($item['transactionDate'], $month)));
    $income = sum_items(array_filter($monthTransactions, fn($item) => $item['kind'] === 'income'));
    $expenses = sum_items(array_filter($monthTransactions, fn($item) => $item['kind'] === 'expense'));
    $payable = array_values(array_filter($confirmed, fn($item) => $item['status'] === 'scheduled'));

    return [
        'messages' => $data['messages'],
        'transactions' => $confirmed,
        'pendingTransactions' => $pending,
        'documents' => $data['documents'],
        'summary' => [
            'income' => $income,
            'expenses' => $expenses,
            'result' => round($income - $expenses, 2),
            'payableTotal' => sum_items($payable),
            'payableCount' => count($payable),
            'categories' => group_by_category($monthTransactions),
        ],
    ];
}

function parse_financial_message(string $text, array $env = []): array
{
    $aiParsed = parse_with_openai($text, $env);
    if ($aiParsed !== null) {
        return $aiParsed;
    }

    $normalized = normalize_text($text);
    $amount = extract_amount($normalized);
    if (!$amount) {
        return [
            'intent' => 'question',
            'answer' => str_contains($normalized, 'quanto') || str_contains($normalized, 'gastei')
                ? 'Ainda estou aprendendo a responder perguntas analiticas. Por enquanto, use o painel ao lado para acompanhar seus totais.'
                : 'Nao encontrei um valor financeiro nessa mensagem. Tente algo como: paguei R$ 89,90 no mercado hoje.',
        ];
    }

    $kind = detect_kind($normalized);
    $date = extract_date($normalized);
    $isPayable = $kind === 'expense' && preg_match('/\b(vence|vencimento|pagar|boleto)\b/', $normalized);

    return [
        'intent' => 'transaction',
        'transaction' => [
            'kind' => $kind,
            'status' => $isPayable ? 'scheduled' : 'confirmed',
            'amount' => $amount,
            'description' => mb_substr(preg_replace('/\s+/', ' ', trim($text)), 0, 160),
            'merchant' => extract_merchant($text),
            'paymentMethod' => detect_payment_method($normalized),
            'transactionDate' => $date,
            'dueDate' => $isPayable ? $date : null,
            'category' => detect_category($normalized, $kind),
            'source' => 'chat',
            'rawText' => $text,
            'confidence' => 1,
        ],
    ];
}

function parse_with_openai(string $text, array $env): ?array
{
    $apiKey = trim((string)($env['OPENAI_API_KEY'] ?? ''));
    if ($apiKey === '' || !function_exists('curl_init')) {
        return null;
    }

    $baseUrl = rtrim((string)($env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'), '/');
    $model = trim((string)($env['OPENAI_MODEL'] ?? 'gpt-4.1-nano')) ?: 'gpt-4.1-nano';
    $today = date('Y-m-d');

    $body = [
        'model' => $model,
        'temperature' => 0,
        'response_format' => ['type' => 'json_object'],
        'messages' => [
            [
                'role' => 'system',
                'content' => 'Voce extrai dados financeiros pessoais de mensagens em portugues do Brasil. Responda somente JSON valido. Se houver transacao, use intent transaction. Se for pergunta ou texto sem valor financeiro, use intent question.',
            ],
            [
                'role' => 'user',
                'content' => json_encode([
                    'today' => $today,
                    'message' => $text,
                    'schema' => [
                        'intent' => 'transaction|question',
                        'answer' => 'string opcional para question',
                        'transaction' => [
                            'kind' => 'income|expense',
                            'amount' => 'number',
                            'description' => 'string',
                            'merchant' => 'string|null',
                            'paymentMethod' => 'Pix|Cartao|Dinheiro|Boleto|null',
                            'transactionDate' => 'YYYY-MM-DD',
                            'dueDate' => 'YYYY-MM-DD|null',
                            'category' => 'Mercado|Alimentação|Moradia|Transporte|Saúde|Educação|Lazer|Renda|Outros',
                            'confidence' => 'number de 0 a 1',
                        ],
                    ],
                ], JSON_UNESCAPED_UNICODE),
            ],
        ],
    ];

    $curl = curl_init("{$baseUrl}/chat/completions");
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            "Authorization: Bearer {$apiKey}",
        ],
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT => 12,
    ]);

    $raw = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) {
        return null;
    }

    $payload = json_decode((string)$raw, true);
    $content = $payload['choices'][0]['message']['content'] ?? null;
    if (!is_string($content) || $content === '') {
        return null;
    }

    $decoded = json_decode($content, true);
    return is_array($decoded) ? normalize_ai_result($decoded, $text, $today) : null;
}

function normalize_ai_result(array $result, string $rawText, string $today): ?array
{
    if (($result['intent'] ?? '') !== 'transaction') {
        return [
            'intent' => 'question',
            'answer' => (string)($result['answer'] ?? 'Nao encontrei um valor financeiro nessa mensagem. Tente algo como: paguei R$ 89,90 no mercado hoje.'),
        ];
    }

    $transaction = $result['transaction'] ?? [];
    $amount = (float)($transaction['amount'] ?? 0);
    if ($amount <= 0) {
        return null;
    }

    $kind = ($transaction['kind'] ?? '') === 'income' ? 'income' : 'expense';
    $transactionDate = is_iso_date((string)($transaction['transactionDate'] ?? '')) ? (string)$transaction['transactionDate'] : $today;
    $dueDate = is_iso_date((string)($transaction['dueDate'] ?? '')) ? (string)$transaction['dueDate'] : null;

    return [
        'intent' => 'transaction',
        'transaction' => [
            'kind' => $kind,
            'status' => $dueDate && $kind === 'expense' ? 'scheduled' : 'confirmed',
            'amount' => $amount,
            'description' => mb_substr(trim((string)($transaction['description'] ?? $rawText)) ?: $rawText, 0, 160),
            'merchant' => trim((string)($transaction['merchant'] ?? '')) ?: null,
            'paymentMethod' => trim((string)($transaction['paymentMethod'] ?? '')) ?: null,
            'transactionDate' => $transactionDate,
            'dueDate' => $dueDate,
            'category' => normalize_category((string)($transaction['category'] ?? ''), $kind),
            'source' => 'chat',
            'rawText' => $rawText,
            'confidence' => max(0, min(1, (float)($transaction['confidence'] ?? 0.8))),
        ],
    ];
}

function normalize_category(string $category, string $kind): string
{
    $allowed = ['Mercado', 'Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Renda', 'Outros'];
    return in_array($category, $allowed, true) ? $category : ($kind === 'income' ? 'Renda' : 'Outros');
}

function is_iso_date(string $value): bool
{
    return preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) === 1;
}

function normalize_transaction_changes(array $body): array
{
    $amount = (float)str_replace(',', '.', (string)($body['amount'] ?? ''));
    if ($amount <= 0) {
        throw new RuntimeException('Valor invalido.');
    }

    $kind = ($body['kind'] ?? '') === 'income' ? 'income' : 'expense';
    return [
        'kind' => $kind,
        'amount' => $amount,
        'description' => mb_substr(trim((string)($body['description'] ?? '')) ?: 'Lancamento sem descricao', 0, 160),
        'merchant' => trim((string)($body['merchant'] ?? '')) ?: null,
        'paymentMethod' => trim((string)($body['paymentMethod'] ?? '')) ?: null,
        'transactionDate' => normalize_date((string)($body['transactionDate'] ?? '')),
        'dueDate' => trim((string)($body['dueDate'] ?? '')) !== '' ? normalize_date((string)$body['dueDate']) : null,
        'category' => trim((string)($body['category'] ?? '')) ?: ($kind === 'income' ? 'Renda' : 'Outros'),
    ];
}

function normalize_date(string $value): string
{
    $date = substr($value, 0, 10);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        throw new RuntimeException('Data invalida.');
    }
    return $date;
}

function extract_amount(string $text): ?float
{
    $patterns = [
        '/r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/i',
        '/\b(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b/i',
        '/\b(?:valor|de|por|gastei|paguei|comprei|recebi)\s+(\d{1,3}(?:\.\d{3})+|\d+)\b/i',
        '/\b(\d{1,3}(?:\.\d{3})+|\d+)\s+(?:reais|real)\b/i',
    ];
    foreach ($patterns as $pattern) {
        if (preg_match($pattern, $text, $matches)) {
            $integer = str_replace('.', '', $matches[1]);
            $cents = $matches[2] ?? '00';
            return (float)"{$integer}.{$cents}";
        }
    }
    return null;
}

function detect_kind(string $text): string
{
    return preg_match('/\b(recebi|receita|salario|pix recebido|deposito)\b/', $text) ? 'income' : 'expense';
}

function extract_date(string $text): string
{
    $timestamp = time();
    if (preg_match('/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/', $text, $matches)) {
        $year = isset($matches[3]) ? (int)$matches[3] : (int)date('Y');
        if ($year < 100) {
            $year += 2000;
        }
        return sprintf('%04d-%02d-%02d', $year, (int)$matches[2], (int)$matches[1]);
    }
    if (str_contains($text, 'ontem')) {
        $timestamp = strtotime('-1 day');
    } elseif (str_contains($text, 'amanha')) {
        $timestamp = strtotime('+1 day');
    }
    return date('Y-m-d', $timestamp);
}

function detect_category(string $text, string $kind): string
{
    $rules = [
        'Moradia' => ['/\baluguel\b/', '/\bcondominio\b/', '/\benergia\b/', '/\bluz\b/', '/\bagua\b/', '/\binternet\b/'],
        'Mercado' => ['/\bmercad\w*\b/', '/\bsupermercad\w*\b/', '/\bmercearia\b/', '/\bfeira\b/', '/\bhortifruti\b/'],
        'Alimentação' => ['/\bifood\b/', '/\bdelivery\b/', '/\brestaurante\b/', '/\bpadaria\b/', '/\bpao\b/', '/\blanche\b/'],
        'Transporte' => ['/\buber\b/', '/\b99\b/', '/\bgasolina\b/', '/\bcombustivel\b/', '/\bestacionamento\b/'],
        'Saúde' => ['/\bfarmacia\b/', '/\bmedico\b/', '/\bconsulta\b/', '/\bplano de saude\b/'],
        'Educação' => ['/\bcurso\b/', '/\bfaculdade\b/', '/\blivro\b/', '/\bescola\b/'],
        'Lazer' => ['/\bcinema\b/', '/\bbar\b/', '/\bshow\b/', '/\bviagem\b/', '/\bnetflix\b/', '/\bspotify\b/'],
        'Renda' => ['/\bsalario\b/', '/\bfreela\b/', '/\brecebi\b/', '/\breceita\b/'],
    ];
    foreach ($rules as $category => $patterns) {
        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $text)) {
                return $category;
            }
        }
    }
    return $kind === 'income' ? 'Renda' : 'Outros';
}

function detect_payment_method(string $text): ?string
{
    if (str_contains($text, 'pix')) return 'Pix';
    if (str_contains($text, 'cartao')) return 'Cartao';
    if (str_contains($text, 'dinheiro')) return 'Dinheiro';
    if (str_contains($text, 'boleto')) return 'Boleto';
    return null;
}

function extract_merchant(string $text): ?string
{
    if (preg_match('/\b(?:no|na|em|para|com)\s+([A-Za-zÀ-ÿ0-9 ]{3,40})/u', $text, $matches)) {
        return trim($matches[1]);
    }
    return null;
}

function summarize_transaction(array $transaction): string
{
    $money = 'R$ ' . number_format((float)$transaction['amount'], 2, ',', '.');
    $type = $transaction['kind'] === 'income' ? 'receita' : 'despesa';
    $when = date('d/m/Y', strtotime($transaction['transactionDate']));
    $due = $transaction['dueDate'] ? ' Vencimento: ' . date('d/m/Y', strtotime($transaction['dueDate'])) . '.' : '';
    return "Registrei uma {$type} de {$money} em {$transaction['category']}, com data {$when}.{$due}";
}

function normalize_text(string $text): string
{
    $lower = mb_strtolower($text, 'UTF-8');
    $converted = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $lower);
    return $converted === false ? $lower : $converted;
}

function normalize_transaction(array $row): array
{
    $row = normalize_dates($row);
    $row['amount'] = (float)$row['amount'];
    $row['confidence'] = (float)$row['confidence'];
    $row['transactionDate'] = substr((string)$row['transactionDate'], 0, 10);
    $row['dueDate'] = $row['dueDate'] ? substr((string)$row['dueDate'], 0, 10) : null;
    return $row;
}

function normalize_dates(array $row): array
{
    $row['createdAt'] = date('c', strtotime((string)$row['createdAt']));
    return $row;
}

function sum_items(iterable $items): float
{
    $total = 0.0;
    foreach ($items as $item) {
        $total += (float)($item['amount'] ?? 0);
    }
    return round($total, 2);
}

function group_by_category(array $items): array
{
    $groups = [];
    foreach ($items as $item) {
        if ($item['kind'] !== 'expense') {
            continue;
        }
        $groups[$item['category']] = ($groups[$item['category']] ?? 0) + (float)$item['amount'];
    }
    arsort($groups);
    $result = [];
    foreach ($groups as $name => $amount) {
        $result[] = ['name' => $name, 'amount' => round($amount, 2)];
    }
    return $result;
}

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}
