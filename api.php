<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

try {
    $env = load_env(__DIR__ . '/.env');
    $pdo = connect_db($env);
    ensure_schema($pdo);

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = trim((string)($_GET['path'] ?? ''), '/');

    if ($method === 'GET' && $path === 'session') {
        $session = current_session($pdo);
        respond($session ? session_payload($pdo, $session) : ['user' => null, 'controls' => []]);
    }

    if ($method === 'POST' && $path === 'auth/register') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $user = register_user($pdo, $body);
        $controlId = create_control($pdo, (int)$user['id'], 'Meu controle financeiro');
        create_login_session($pdo, (int)$user['id'], $controlId, (bool)($body['remember'] ?? true));
        ensure_welcome_message($pdo, (int)$user['id'], $controlId);
        respond(session_payload($pdo, ['user_id' => (int)$user['id'], 'active_control_id' => $controlId]));
    }

    if ($method === 'POST' && $path === 'auth/login') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $user = authenticate_user($pdo, $body);
        $controls = list_controls($pdo, (int)$user['id']);
        $controlId = (int)($controls[0]['id'] ?? create_control($pdo, (int)$user['id'], 'Meu controle financeiro'));
        create_login_session($pdo, (int)$user['id'], $controlId, (bool)($body['remember'] ?? true));
        ensure_welcome_message($pdo, (int)$user['id'], $controlId);
        respond(session_payload($pdo, ['user_id' => (int)$user['id'], 'active_control_id' => $controlId]));
    }

    if ($method === 'POST' && $path === 'auth/logout') {
        logout($pdo);
        respond(['ok' => true]);
    }

    if ($method === 'POST' && $path === 'auth/forgot') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        request_password_reset($pdo, $env, $body);
        respond(['ok' => true]);
    }

    if ($method === 'POST' && $path === 'auth/reset') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        reset_password($pdo, $body);
        respond(['ok' => true]);
    }

    $session = current_session($pdo);
    if (!$session) {
        respond(['error' => 'Nao autenticado'], 401);
    }

    $userId = (int)$session['user_id'];
    $controlId = (int)$session['active_control_id'];
    if (!user_can_access_control($pdo, $userId, $controlId)) {
        $controls = list_controls($pdo, $userId);
        if (!$controls) {
            $controlId = create_control($pdo, $userId, 'Meu controle financeiro');
        } else {
            $controlId = (int)$controls[0]['id'];
        }
        set_active_control($pdo, $controlId);
    }

    if ($method === 'GET' && $path === 'state') {
        respond(build_state(read_data($pdo, $userId, $controlId), session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])));
    }

    if ($method === 'POST' && $path === 'controls') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $newControlId = create_control($pdo, $userId, trim((string)($body['name'] ?? 'Novo controle financeiro')));
        set_active_control($pdo, $newControlId);
        ensure_welcome_message($pdo, $userId, $newControlId);
        respond(session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $newControlId]));
    }

    if ($method === 'POST' && $path === 'controls/select') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $selectedControlId = (int)($body['controlId'] ?? 0);
        if (!$selectedControlId || !user_can_access_control($pdo, $userId, $selectedControlId)) {
            respond(['error' => 'Controle financeiro indisponivel'], 403);
        }
        set_active_control($pdo, $selectedControlId);
        ensure_welcome_message($pdo, $userId, $selectedControlId);
        respond(session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $selectedControlId]));
    }

    if ($method === 'POST' && $path === 'controls/share') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        share_control($pdo, $userId, $controlId, trim((string)($body['email'] ?? '')));
        respond(session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId]));
    }

    if ($method === 'POST' && $path === 'settings/profile') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        update_profile($pdo, $userId, $body);
        respond(session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId]));
    }

    if ($method === 'POST' && $path === 'settings/password') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        change_password($pdo, $userId, $body);
        respond(['ok' => true]);
    }

    if ($method === 'POST' && $path === 'settings/control') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        rename_control($pdo, $userId, $controlId, $body);
        respond(session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId]));
    }

    if ($method === 'POST' && $path === 'settings/wallets') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        create_wallet($pdo, $userId, $controlId, $body);
        respond(build_state(read_data($pdo, $userId, $controlId), session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])));
    }

    if ($method === 'POST' && preg_match('#^settings/wallets/([^/]+)/(update|remove)$#', $path, $walletMatch)) {
        if ($walletMatch[2] === 'update') {
            $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
            update_wallet($pdo, $controlId, $walletMatch[1], $body);
        } else {
            remove_wallet($pdo, $controlId, $walletMatch[1]);
        }
        respond(build_state(read_data($pdo, $userId, $controlId), session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])));
    }

    if ($method === 'GET' && preg_match('#^documents/([^/]+)/view$#', $path, $matches)) {
        serve_document($pdo, $userId, $controlId, $matches[1], $env);
    }

    if ($method === 'POST' && $path === 'chat') {
        $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $message = trim((string)($body['message'] ?? ''));
        if ($message === '') {
            respond(['error' => 'Mensagem vazia'], 400);
        }
        respond(process_financial_message($pdo, $userId, $controlId, $message, $env));
    }

    if ($method === 'POST' && $path === 'audio') {
        if (!isset($_FILES['audio']) || (int)($_FILES['audio']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            respond(['error' => 'Nenhum áudio válido foi enviado.'], 400);
        }
        $file = $_FILES['audio'];
        if ((int)($file['size'] ?? 0) > 10 * 1024 * 1024) {
            respond(['error' => 'O áudio é muito grande. Grave uma mensagem mais curta.'], 413);
        }
        $mimeType = (string)($file['type'] ?? '');
        if (!str_starts_with($mimeType, 'audio/')) {
            respond(['error' => 'O arquivo enviado não é um áudio válido.'], 400);
        }
        $message = transcribe_audio_with_openai((string)$file['tmp_name'], $mimeType, basename((string)$file['name']), $env);
        if ($message === '') {
            respond(['error' => 'Não consegui identificar fala nesse áudio.'], 422);
        }
        respond(process_financial_message($pdo, $userId, $controlId, $message, $env));
    }

    if ($method === 'POST' && preg_match('#^transactions/([^/]+)/(confirm|dismiss|remove|update)$#', $path, $matches)) {
        if ($matches[2] === 'update') {
            $body = json_decode((string)file_get_contents('php://input'), true) ?: [];
            $changes = normalize_transaction_changes($body);
            if ($changes['accountId'] && !wallet_belongs_to_control($pdo, $changes['accountId'], $controlId)) {
                respond(['error' => 'Carteira inválida para este controle financeiro.'], 400);
            }
            $updated = update_transaction($pdo, $userId, $controlId, $matches[1], $changes);
            if (!$updated) {
                respond(['error' => 'Lancamento nao encontrado'], 404);
            }
            respond(build_state(read_data($pdo, $userId, $controlId), session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])));
        }

        $status = $matches[2] === 'confirm' ? 'confirmed' : 'dismissed';
        $updated = update_transaction_status($pdo, $userId, $controlId, $matches[1], $status);
        if (!$updated) {
            respond(['error' => 'Lancamento nao encontrado'], 404);
        }
        if ($matches[2] === 'confirm' && $updated['kind'] === 'expense' && $updated['dueDate']) {
            $updated = update_transaction_status($pdo, $userId, $controlId, $matches[1], 'scheduled');
        }

        $verb = $matches[2] === 'confirm' ? 'confirmado' : ($matches[2] === 'remove' ? 'removido' : 'descartado');
        add_message($pdo, $userId, $controlId, 'assistant', "Lancamento {$verb}: {$updated['description']}");
        respond(build_state(read_data($pdo, $userId, $controlId), session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])));
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
        $objectName = build_upload_object_name($controlId, $originalName);
        $storedName = $objectName;
        $target = "{$uploadDir}/{$storedName}";
        $targetDir = dirname($target);
        if (!is_dir($targetDir)) {
            mkdir($targetDir, 0755, true);
        }

        if (!move_uploaded_file((string)$file['tmp_name'], $target)) {
            respond(['error' => 'Falha ao salvar upload'], 500);
        }

        $mimeType = (string)($file['type'] ?: 'application/octet-stream');
        $storedName = upload_to_google_cloud_storage($env, $target, $objectName, $mimeType);

        add_document($pdo, $userId, $controlId, [
            'originalName' => $originalName,
            'storedName' => $storedName,
            'mimeType' => $mimeType,
            'status' => 'ocr_pending',
        ]);

        $message = "Recebi o arquivo \"{$originalName}\". ";
        $documentId = (int)$pdo->lastInsertId();
        $parsed = parse_image_with_openai($target, $mimeType, $originalName, $env);

        if (($parsed['intent'] ?? '') === 'transaction') {
            $transaction = $parsed['transaction'];
            $transaction['status'] = 'pending';
            $saved = add_transaction($pdo, $userId, $controlId, $transaction);
            $friendlyName = document_name_from_transaction($saved['description'], $originalName);
            update_document_name($pdo, $userId, $controlId, $documentId, $friendlyName);
            $originalName = $friendlyName;
            update_document_status($pdo, $userId, $controlId, $documentId, 'review_pending');
            $message .= summarize_transaction($saved) . ' Confira os dados extraidos por OCR antes de confirmar.';
        } elseif (str_starts_with($mimeType, 'image/') && trim((string)($env['OPENAI_API_KEY'] ?? '')) !== '') {
            update_document_status($pdo, $userId, $controlId, $documentId, 'failed');
            $message .= 'Tentei fazer OCR, mas nao consegui encontrar uma transacao financeira com seguranca.';
        } elseif (str_starts_with($mimeType, 'image/')) {
            $message .= 'Para fazer OCR automaticamente, configure OPENAI_API_KEY no .env.';
        } else {
            $message .= 'Por enquanto o OCR automatico esta habilitado para imagens. PDF fica salvo para a proxima etapa.';
        }

        add_message($pdo, $userId, $controlId, 'assistant', $message);
        respond(build_state(read_data($pdo, $userId, $controlId), session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])));
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
        $env[trim($key)] = unquote_env_value(trim($value));
    }
    return $env;
}

function unquote_env_value(string $value): string
{
    if (strlen($value) >= 2) {
        $first = $value[0];
        $last = $value[strlen($value) - 1];
        if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
            return substr($value, 1, -1);
        }
    }
    return $value;
}

function build_upload_object_name(int $controlId, string $originalName): string
{
    $extension = pathinfo($originalName, PATHINFO_EXTENSION);
    $safeExtension = $extension !== '' ? preg_replace('/[^a-zA-Z0-9]/', '', $extension) : 'bin';
    return 'controls/' . $controlId . '/documents/' . date('Y-m-d') . '/' . time() . '-' . bin2hex(random_bytes(12)) . '.' . $safeExtension;
}

function upload_to_google_cloud_storage(array $env, string $path, string $objectName, string $mimeType): string
{
    $bucket = trim((string)($env['GOOGLE_CLOUD_BUCKET_NAME'] ?? ''));
    if ($bucket === '') {
        return $objectName;
    }

    $credentials = load_google_credentials($env);
    if ($credentials === null) {
        throw new RuntimeException('GOOGLE_CLOUD_BUCKET_NAME esta configurado, mas nao encontrei credenciais em GOOGLE_CLOUD_CREDENTIALS_FILE ou app/config/keys/*.json.');
    }

    $token = google_access_token($credentials);
    $url = 'https://storage.googleapis.com/upload/storage/v1/b/' . rawurlencode($bucket) . '/o?' . http_build_query([
        'uploadType' => 'media',
        'name' => $objectName,
    ]);

    $content = file_get_contents($path);
    if ($content === false) {
        throw new RuntimeException('Falha ao ler arquivo para envio ao Google Cloud Storage.');
    }

    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer {$token}",
            "Content-Type: {$mimeType}",
            'Content-Length: ' . strlen($content),
        ],
        CURLOPT_POSTFIELDS => $content,
        CURLOPT_TIMEOUT => 30,
    ]);

    $raw = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) {
        throw new RuntimeException("Falha ao enviar arquivo para o Google Cloud Storage ({$status}). " . (string)$raw);
    }

    return "gs://{$bucket}/{$objectName}";
}

function load_google_credentials(array $env): ?array
{
    $explicitPath = trim((string)($env['GOOGLE_CLOUD_CREDENTIALS_FILE'] ?? ''));
    if ($explicitPath !== '') {
        $path = str_starts_with($explicitPath, '/') ? $explicitPath : __DIR__ . '/' . $explicitPath;
        if (!is_file($path)) {
            throw new RuntimeException('Arquivo de credenciais do Google Cloud nao encontrado.');
        }
        $credentials = json_decode((string)file_get_contents($path), true);
        return is_array($credentials) ? $credentials : null;
    }

    $keysDir = __DIR__ . '/app/config/keys';
    if (!is_dir($keysDir)) {
        return null;
    }

    $files = glob($keysDir . '/*.json') ?: [];
    if (!$files) {
        return null;
    }

    $credentials = json_decode((string)file_get_contents($files[0]), true);
    return is_array($credentials) ? $credentials : null;
}

function google_access_token(array $credentials): string
{
    static $cache = null;
    $now = time();
    if (is_array($cache) && (int)$cache['expires_at'] > $now + 60) {
        return (string)$cache['token'];
    }

    $assertion = sign_google_jwt($credentials, $now);
    $curl = curl_init('https://oauth2.googleapis.com/token');
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_POSTFIELDS => http_build_query([
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion' => $assertion,
        ]),
        CURLOPT_TIMEOUT => 20,
    ]);

    $raw = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) {
        throw new RuntimeException("Falha ao autenticar no Google Cloud ({$status}). " . (string)$raw);
    }

    $payload = json_decode((string)$raw, true);
    if (!is_array($payload) || empty($payload['access_token'])) {
        throw new RuntimeException('Resposta invalida da autenticacao do Google Cloud.');
    }

    $cache = [
        'token' => (string)$payload['access_token'],
        'expires_at' => $now + (int)($payload['expires_in'] ?? 3600),
    ];
    return (string)$cache['token'];
}

function sign_google_jwt(array $credentials, int $now): string
{
    $header = ['alg' => 'RS256', 'typ' => 'JWT'];
    $claim = [
        'iss' => (string)($credentials['client_email'] ?? ''),
        'scope' => 'https://www.googleapis.com/auth/devstorage.read_write',
        'aud' => 'https://oauth2.googleapis.com/token',
        'exp' => $now + 3600,
        'iat' => $now,
    ];

    $unsigned = base64_url_encode(json_encode($header, JSON_UNESCAPED_SLASHES)) . '.' .
        base64_url_encode(json_encode($claim, JSON_UNESCAPED_SLASHES));

    $signature = '';
    $privateKey = (string)($credentials['private_key'] ?? '');
    if ($privateKey === '' || !openssl_sign($unsigned, $signature, $privateKey, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('Falha ao assinar autenticacao do Google Cloud.');
    }
    return $unsigned . '.' . base64_url_encode($signature);
}

function base64_url_encode(string $content): string
{
    return rtrim(strtr(base64_encode($content), '+/', '-_'), '=');
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

    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_controls (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        owner_user_id BIGINT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_controls_owner (owner_user_id)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS control_members (
        control_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role ENUM('owner', 'editor', 'viewer') NOT NULL DEFAULT 'editor',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (control_id, user_id),
        INDEX idx_members_user (user_id)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        active_control_id BIGINT UNSIGNED NULL,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sessions_user (user_id),
        INDEX idx_sessions_expires (expires_at)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reset_user (user_id),
        INDEX idx_reset_expires (expires_at)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        kind ENUM('income', 'expense') NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_categories_control_name_kind (control_id, name, kind)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        type ENUM('checking', 'savings', 'cash', 'credit_card', 'investment') NOT NULL,
        opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS transactions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        control_id BIGINT UNSIGNED NULL,
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
        control_id BIGINT UNSIGNED NULL,
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
        control_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role ENUM('user', 'assistant', 'system') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chat_user_created (user_id, created_at)
    )");

    add_column_if_missing($pdo, 'categories', 'control_id', 'BIGINT UNSIGNED NULL AFTER id');
    add_column_if_missing($pdo, 'financial_accounts', 'control_id', 'BIGINT UNSIGNED NULL AFTER id');
    add_column_if_missing($pdo, 'transactions', 'control_id', 'BIGINT UNSIGNED NULL AFTER id');
    add_column_if_missing($pdo, 'documents', 'control_id', 'BIGINT UNSIGNED NULL AFTER id');
    add_column_if_missing($pdo, 'chat_messages', 'control_id', 'BIGINT UNSIGNED NULL AFTER id');
    migrate_default_control($pdo);
    ensure_category_unique_index($pdo);
}

function add_column_if_missing(PDO $pdo, string $table, string $column, string $definition): void
{
    try {
        $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
    } catch (Throwable $error) {
        if (!str_contains($error->getMessage(), 'Duplicate column')) {
            throw $error;
        }
    }
}

function migrate_default_control(PDO $pdo): void
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO users (name, email) VALUES (?, ?)');
    $stmt->execute(['Usuario principal', 'usuario@local']);
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $stmt->execute(['usuario@local']);
    $userId = (int)$stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT id FROM financial_controls WHERE owner_user_id = ? ORDER BY id LIMIT 1');
    $stmt->execute([$userId]);
    $controlId = (int)$stmt->fetchColumn();
    if (!$controlId) {
        $stmt = $pdo->prepare('INSERT INTO financial_controls (name, owner_user_id) VALUES (?, ?)');
        $stmt->execute(['Meu controle financeiro', $userId]);
        $controlId = (int)$pdo->lastInsertId();
    }
    $stmt = $pdo->prepare('INSERT IGNORE INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)');
    $stmt->execute([$controlId, $userId, 'owner']);

    foreach (['categories', 'transactions', 'documents', 'chat_messages'] as $table) {
        $pdo->prepare("UPDATE {$table} SET control_id = ? WHERE control_id IS NULL")->execute([$controlId]);
    }
    $stmt = $pdo->prepare('UPDATE financial_accounts SET control_id = ? WHERE control_id IS NULL AND user_id = ?');
    $stmt->execute([$controlId, $userId]);
    $pdo->exec('UPDATE financial_accounts a INNER JOIN (SELECT user_id, MIN(control_id) AS control_id FROM control_members GROUP BY user_id) m ON m.user_id = a.user_id SET a.control_id = m.control_id WHERE a.control_id IS NULL');
}

function ensure_category_unique_index(PDO $pdo): void
{
    try {
        $pdo->exec('ALTER TABLE categories DROP INDEX uq_categories_user_name_kind');
    } catch (Throwable $error) {
        if (!str_contains($error->getMessage(), 'check that')) {
            throw $error;
        }
    }

    try {
        $pdo->exec('ALTER TABLE categories ADD UNIQUE KEY uq_categories_control_name_kind (control_id, name, kind)');
    } catch (Throwable $error) {
        if (str_contains($error->getMessage(), 'Duplicate entry')) {
            dedupe_categories($pdo);
            $pdo->exec('ALTER TABLE categories ADD UNIQUE KEY uq_categories_control_name_kind (control_id, name, kind)');
            return;
        }
        if (!str_contains($error->getMessage(), 'Duplicate key name')) {
            throw $error;
        }
    }
}

function dedupe_categories(PDO $pdo): void
{
    $pdo->exec("UPDATE transactions t
        INNER JOIN categories c ON c.id = t.category_id
        INNER JOIN (
            SELECT MIN(id) AS keep_id, control_id, name, kind
            FROM categories
            GROUP BY control_id, name, kind
        ) keeper ON keeper.control_id <=> c.control_id AND keeper.name = c.name AND keeper.kind = c.kind
        SET t.category_id = keeper.keep_id
        WHERE c.id <> keeper.keep_id");

    $pdo->exec("DELETE c FROM categories c
        INNER JOIN (
            SELECT MIN(id) AS keep_id, control_id, name, kind
            FROM categories
            GROUP BY control_id, name, kind
        ) keeper ON keeper.control_id <=> c.control_id AND keeper.name = c.name AND keeper.kind = c.kind
        WHERE c.id <> keeper.keep_id");
}

function ensure_welcome_message(PDO $pdo, int $userId, int $controlId): void
{
    $stmt = $pdo->prepare('SELECT id FROM chat_messages WHERE user_id = ? AND control_id = ? LIMIT 1');
    $stmt->execute([$userId, $controlId]);
    if ($stmt->fetchColumn()) {
        return;
    }
    add_message($pdo, $userId, $controlId, 'assistant', 'Me diga uma despesa, receita ou conta a pagar. Tambem posso receber um comprovante ou boleto por upload.');
}

function register_user(PDO $pdo, array $body): array
{
    $name = trim((string)($body['name'] ?? ''));
    $email = strtolower(trim((string)($body['email'] ?? '')));
    $password = (string)($body['password'] ?? '');
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 6) {
        respond(['error' => 'Informe nome, e-mail valido e senha com pelo menos 6 caracteres.'], 400);
    }

    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $stmt->execute([$email]);
    if ($stmt->fetchColumn()) {
        respond(['error' => 'Este e-mail ja esta cadastrado.'], 409);
    }

    $stmt = $pdo->prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
    $stmt->execute([$name, $email, hash_password($password)]);
    return ['id' => (int)$pdo->lastInsertId(), 'name' => $name, 'email' => $email];
}

function authenticate_user(PDO $pdo, array $body): array
{
    $email = strtolower(trim((string)($body['email'] ?? '')));
    $password = (string)($body['password'] ?? '');
    $stmt = $pdo->prepare('SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1');
    $stmt->execute([$email]);
    $user = $stmt->fetch();
    if (!$user || !$user['password_hash'] || !verify_password($password, (string)$user['password_hash'])) {
        respond(['error' => 'E-mail ou senha invalidos.'], 401);
    }
    return $user;
}

function hash_password(string $password): string
{
    $iterations = 210000;
    $salt = bin2hex(random_bytes(16));
    $hash = hash_pbkdf2('sha256', $password, $salt, $iterations, 64);
    return "pbkdf2_sha256:{$iterations}:{$salt}:{$hash}";
}

function verify_password(string $password, string $storedHash): bool
{
    if (str_starts_with($storedHash, 'pbkdf2_sha256:')) {
        $parts = explode(':', $storedHash);
        if (count($parts) !== 4) {
            return false;
        }
        [, $iterations, $salt, $expected] = $parts;
        $actual = hash_pbkdf2('sha256', $password, $salt, (int)$iterations, 64);
        return hash_equals($expected, $actual);
    }

    return password_verify($password, $storedHash);
}

function update_profile(PDO $pdo, int $userId, array $body): void
{
    $name = mb_substr(trim((string)($body['name'] ?? '')), 0, 120);
    $email = strtolower(trim((string)($body['email'] ?? '')));
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) respond(['error' => 'Informe nome e e-mail válidos.'], 400);
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1');
    $stmt->execute([$email, $userId]);
    if ($stmt->fetchColumn()) respond(['error' => 'Este e-mail já está sendo usado.'], 409);
    $stmt = $pdo->prepare('UPDATE users SET name = ?, email = ? WHERE id = ?');
    $stmt->execute([$name, $email, $userId]);
}

function change_password(PDO $pdo, int $userId, array $body): void
{
    $current = (string)($body['currentPassword'] ?? '');
    $new = (string)($body['newPassword'] ?? '');
    if (strlen($new) < 6) respond(['error' => 'A nova senha precisa ter pelo menos 6 caracteres.'], 400);
    $stmt = $pdo->prepare('SELECT password_hash FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([$userId]);
    $hash = (string)($stmt->fetchColumn() ?: '');
    if ($hash === '' || !verify_password($current, $hash)) respond(['error' => 'A senha atual está incorreta.'], 401);
    $stmt = $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    $stmt->execute([hash_password($new), $userId]);
}

function rename_control(PDO $pdo, int $userId, int $controlId, array $body): void
{
    $name = mb_substr(trim((string)($body['name'] ?? '')), 0, 160);
    if ($name === '') respond(['error' => 'Informe o nome do controle financeiro.'], 400);
    $stmt = $pdo->prepare('SELECT id FROM financial_controls WHERE id = ? AND owner_user_id = ? LIMIT 1');
    $stmt->execute([$controlId, $userId]);
    if (!$stmt->fetchColumn()) respond(['error' => 'Somente o proprietário pode alterar este nome.'], 403);
    $stmt = $pdo->prepare('UPDATE financial_controls SET name = ? WHERE id = ?');
    $stmt->execute([$name, $controlId]);
}

function normalize_wallet(array $body): array
{
    $types = ['checking', 'savings', 'cash', 'credit_card', 'investment'];
    $name = mb_substr(trim((string)($body['name'] ?? '')), 0, 120);
    $type = in_array($body['type'] ?? '', $types, true) ? $body['type'] : 'checking';
    $openingBalance = (float)str_replace(',', '.', (string)($body['openingBalance'] ?? '0'));
    if ($name === '' || !is_finite($openingBalance)) respond(['error' => 'Preencha os dados da carteira corretamente.'], 400);
    return compact('name', 'type', 'openingBalance');
}

function create_wallet(PDO $pdo, int $userId, int $controlId, array $body): void
{
    $wallet = normalize_wallet($body);
    $stmt = $pdo->prepare('INSERT INTO financial_accounts (control_id, user_id, name, type, opening_balance) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$controlId, $userId, $wallet['name'], $wallet['type'], $wallet['openingBalance']]);
}

function update_wallet(PDO $pdo, int $controlId, string $walletId, array $body): void
{
    $wallet = normalize_wallet($body);
    $stmt = $pdo->prepare('UPDATE financial_accounts SET name = ?, type = ?, opening_balance = ? WHERE id = ? AND control_id = ?');
    $stmt->execute([$wallet['name'], $wallet['type'], $wallet['openingBalance'], $walletId, $controlId]);
    if ($stmt->rowCount() === 0 && !wallet_belongs_to_control($pdo, $walletId, $controlId)) respond(['error' => 'Carteira não encontrada.'], 404);
}

function remove_wallet(PDO $pdo, int $controlId, string $walletId): void
{
    $stmt = $pdo->prepare('SELECT id FROM transactions WHERE account_id = ? AND control_id = ? LIMIT 1');
    $stmt->execute([$walletId, $controlId]);
    if ($stmt->fetchColumn()) respond(['error' => 'Esta carteira possui lançamentos e não pode ser removida.'], 409);
    $stmt = $pdo->prepare('DELETE FROM financial_accounts WHERE id = ? AND control_id = ?');
    $stmt->execute([$walletId, $controlId]);
    if ($stmt->rowCount() === 0) respond(['error' => 'Carteira não encontrada.'], 404);
}

function wallet_belongs_to_control(PDO $pdo, string $walletId, int $controlId): bool
{
    $stmt = $pdo->prepare('SELECT id FROM financial_accounts WHERE id = ? AND control_id = ? LIMIT 1');
    $stmt->execute([$walletId, $controlId]);
    return (bool)$stmt->fetchColumn();
}

function request_password_reset(PDO $pdo, array $env, array $body): void
{
    $email = strtolower(trim((string)($body['email'] ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return;
    }

    $stmt = $pdo->prepare('SELECT id, name, email FROM users WHERE email = ? LIMIT 1');
    $stmt->execute([$email]);
    $user = $stmt->fetch();
    if (!$user) {
        return;
    }

    $stmt = $pdo->prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at <= NOW())');
    $stmt->execute([(int)$user['id']]);

    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $expires = time() + 60 * 60;
    $stmt = $pdo->prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, FROM_UNIXTIME(?))');
    $stmt->execute([hash('sha256', $token), (int)$user['id'], $expires]);

    $resetUrl = request_origin() . '/?reset=' . rawurlencode($token);
    send_mail($env, [
        'to' => (string)$user['email'],
        'subject' => 'Redefinicao de senha do Finup',
        'text' => implode("\n", [
            'Ola, ' . (string)$user['name'] . '.',
            '',
            'Recebemos uma solicitacao para redefinir sua senha no Finup.',
            'Use este link para criar uma nova senha: ' . $resetUrl,
            '',
            'Este link expira em 1 hora. Se voce nao solicitou, ignore este e-mail.',
        ]),
    ]);
}

function reset_password(PDO $pdo, array $body): void
{
    $token = trim((string)($body['token'] ?? ''));
    $password = (string)($body['password'] ?? '');
    if ($token === '' || strlen($password) < 6) {
        respond(['error' => 'Link invalido ou senha muito curta.'], 400);
    }

    $stmt = $pdo->prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1');
    $stmt->execute([hash('sha256', $token)]);
    $reset = $stmt->fetch();
    if (!$reset) {
        respond(['error' => 'Link invalido ou expirado.'], 400);
    }

    $userId = (int)$reset['user_id'];
    $stmt = $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    $stmt->execute([hash_password($password), $userId]);
    $stmt = $pdo->prepare('UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = ?');
    $stmt->execute([hash('sha256', $token)]);
    $stmt = $pdo->prepare('DELETE FROM user_sessions WHERE user_id = ?');
    $stmt->execute([$userId]);
}

function request_origin(): string
{
    $host = (string)($_SERVER['HTTP_HOST'] ?? 'localhost');
    $proto = (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? (!empty($_SERVER['HTTPS']) ? 'https' : 'http'));
    return $proto . '://' . $host;
}

function send_mail(array $env, array $message): void
{
    $host = trim((string)($env['MAIL_HOST'] ?? ''));
    $port = (int)($env['MAIL_PORT'] ?? 465);
    $username = trim((string)($env['MAIL_USERNAME'] ?? ''));
    $password = (string)($env['MAIL_PASSWORD'] ?? '');
    $fromEmail = trim((string)($env['MAIL_FROM_EMAIL'] ?? $username));
    $fromName = trim((string)($env['MAIL_FROM_NAME'] ?? 'Finup')) ?: 'Finup';
    if ($host === '' || $username === '' || $password === '' || $fromEmail === '') {
        throw new RuntimeException('Configuracao de e-mail incompleta.');
    }

    $socket = stream_socket_client("ssl://{$host}:{$port}", $errno, $errstr, 20);
    if (!$socket) {
        throw new RuntimeException("Falha ao conectar no SMTP: {$errstr}");
    }
    stream_set_timeout($socket, 20);

    smtp_read($socket);
    smtp_command($socket, "EHLO {$host}");
    smtp_command($socket, 'AUTH LOGIN');
    smtp_command($socket, base64_encode($username));
    smtp_command($socket, base64_encode($password));
    smtp_command($socket, "MAIL FROM:<{$fromEmail}>");
    smtp_command($socket, 'RCPT TO:<' . (string)$message['to'] . '>');
    smtp_command($socket, 'DATA', [354]);
    fwrite($socket, build_email_message($fromEmail, $fromName, (string)$message['to'], (string)$message['subject'], (string)$message['text']));
    smtp_read($socket);
    smtp_command($socket, 'QUIT');
    fclose($socket);
}

function smtp_command($socket, string $command, array $acceptedCodes = [200, 220, 221, 235, 250, 251, 334, 354]): string
{
    fwrite($socket, $command . "\r\n");
    $response = smtp_read($socket);
    $code = (int)substr($response, 0, 3);
    if (!in_array($code, $acceptedCodes, true)) {
        throw new RuntimeException('Erro SMTP: ' . trim($response));
    }
    return $response;
}

function smtp_read($socket): string
{
    $response = '';
    while (($line = fgets($socket, 515)) !== false) {
        $response .= $line;
        if (preg_match('/^\d{3} /', $line)) {
            break;
        }
    }
    $code = (int)substr($response, 0, 3);
    if ($code >= 400) {
        throw new RuntimeException('Erro SMTP: ' . trim($response));
    }
    return $response;
}

function build_email_message(string $fromEmail, string $fromName, string $to, string $subject, string $text): string
{
    $headers = [
        'From: ' . encode_mail_header($fromName) . " <{$fromEmail}>",
        "To: <{$to}>",
        'Subject: ' . encode_mail_header($subject),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
    ];
    $escapedText = str_replace("\n.", "\n..", $text);
    return implode("\r\n", $headers) . "\r\n\r\n" . $escapedText . "\r\n.\r\n";
}

function encode_mail_header(string $value): string
{
    return '=?UTF-8?B?' . base64_encode($value) . '?=';
}

function create_login_session(PDO $pdo, int $userId, int $controlId, bool $remember): void
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + ($remember ? 60 * 60 * 24 * 45 : 60 * 60 * 8);
    $stmt = $pdo->prepare('INSERT INTO user_sessions (token_hash, user_id, active_control_id, expires_at) VALUES (?, ?, ?, FROM_UNIXTIME(?))');
    $stmt->execute([hash('sha256', $token), $userId, $controlId, $expires]);
    setcookie('finance_session', $token, [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => !empty($_SERVER['HTTPS']),
    ]);
}

function current_session(PDO $pdo): ?array
{
    $token = (string)($_COOKIE['finance_session'] ?? '');
    if ($token === '') {
        return null;
    }
    $stmt = $pdo->prepare('SELECT user_id, active_control_id FROM user_sessions WHERE token_hash = ? AND expires_at > NOW() LIMIT 1');
    $stmt->execute([hash('sha256', $token)]);
    $session = $stmt->fetch();
    return $session ?: null;
}

function logout(PDO $pdo): void
{
    $token = (string)($_COOKIE['finance_session'] ?? '');
    if ($token !== '') {
        $stmt = $pdo->prepare('DELETE FROM user_sessions WHERE token_hash = ?');
        $stmt->execute([hash('sha256', $token)]);
    }
    setcookie('finance_session', '', [
        'expires' => time() - 3600,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => !empty($_SERVER['HTTPS']),
    ]);
}

function create_control(PDO $pdo, int $userId, string $name): int
{
    $name = trim($name) ?: 'Novo controle financeiro';
    $stmt = $pdo->prepare('INSERT INTO financial_controls (name, owner_user_id) VALUES (?, ?)');
    $stmt->execute([mb_substr($name, 0, 160), $userId]);
    $controlId = (int)$pdo->lastInsertId();
    $stmt = $pdo->prepare('INSERT INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)');
    $stmt->execute([$controlId, $userId, 'owner']);
    return $controlId;
}

function list_controls(PDO $pdo, int $userId): array
{
    $stmt = $pdo->prepare('SELECT CAST(c.id AS CHAR) AS id, c.name, m.role FROM financial_controls c INNER JOIN control_members m ON m.control_id = c.id WHERE m.user_id = ? ORDER BY c.name ASC');
    $stmt->execute([$userId]);
    return $stmt->fetchAll();
}

function user_can_access_control(PDO $pdo, int $userId, int $controlId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM control_members WHERE user_id = ? AND control_id = ? LIMIT 1');
    $stmt->execute([$userId, $controlId]);
    return (bool)$stmt->fetchColumn();
}

function set_active_control(PDO $pdo, int $controlId): void
{
    $token = (string)($_COOKIE['finance_session'] ?? '');
    if ($token === '') return;
    $stmt = $pdo->prepare('UPDATE user_sessions SET active_control_id = ? WHERE token_hash = ?');
    $stmt->execute([$controlId, hash('sha256', $token)]);
}

function share_control(PDO $pdo, int $ownerUserId, int $controlId, string $email): void
{
    $stmt = $pdo->prepare('SELECT id FROM financial_controls WHERE id = ? AND owner_user_id = ? LIMIT 1');
    $stmt->execute([$controlId, $ownerUserId]);
    if (!$stmt->fetchColumn()) respond(['error' => 'Somente o proprietário pode compartilhar este controle.'], 403);
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $stmt->execute([strtolower($email)]);
    $targetUserId = (int)$stmt->fetchColumn();
    if (!$targetUserId) {
        respond(['error' => 'Usuario nao encontrado. Ele precisa criar uma conta primeiro.'], 404);
    }
    $stmt = $pdo->prepare('INSERT IGNORE INTO control_members (control_id, user_id, role) VALUES (?, ?, ?)');
    $stmt->execute([$controlId, $targetUserId, 'editor']);
}

function session_payload(PDO $pdo, array $session): array
{
    $stmt = $pdo->prepare('SELECT CAST(id AS CHAR) AS id, name, email FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([(int)$session['user_id']]);
    $user = $stmt->fetch();
    return [
        'user' => $user,
        'controls' => list_controls($pdo, (int)$session['user_id']),
        'activeControlId' => isset($session['active_control_id']) ? (string)$session['active_control_id'] : null,
    ];
}

function read_data(PDO $pdo, int $userId, int $controlId): array
{
    $stmt = $pdo->prepare('SELECT CAST(id AS CHAR) AS id, role, content, created_at AS createdAt FROM chat_messages WHERE control_id = ? ORDER BY created_at ASC, id ASC');
    $stmt->execute([$controlId]);
    $messages = array_map('normalize_dates', $stmt->fetchAll());

    $stmt = $pdo->prepare("SELECT
        CAST(t.id AS CHAR) AS id,
        t.kind,
        t.status,
        CAST(t.amount AS DECIMAL(14,2)) AS amount,
        t.description,
        t.merchant,
        t.payment_method AS paymentMethod,
        CAST(t.account_id AS CHAR) AS accountId,
        a.name AS accountName,
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
        ORDER BY t.created_at DESC, t.id DESC");
    $stmt->execute([$controlId]);
    $transactions = array_map('normalize_transaction', $stmt->fetchAll());

    $stmt = $pdo->prepare('SELECT CAST(id AS CHAR) AS id, original_name AS originalName, stored_name AS storedName, mime_type AS mimeType, status, created_at AS createdAt FROM documents WHERE control_id = ? ORDER BY created_at DESC, id DESC');
    $stmt->execute([$controlId]);
    $documents = array_map('normalize_dates', $stmt->fetchAll());

    $stmt = $pdo->prepare("SELECT CAST(a.id AS CHAR) AS id, a.name, a.type,
        CAST(a.opening_balance AS DECIMAL(14,2)) AS openingBalance,
        CAST(a.opening_balance + COALESCE(SUM(CASE
          WHEN t.status IN ('confirmed', 'paid') AND t.kind = 'income' THEN t.amount
          WHEN t.status IN ('confirmed', 'paid') AND t.kind = 'expense' THEN -t.amount
          ELSE 0 END), 0) AS DECIMAL(14,2)) AS balance
        FROM financial_accounts a
        LEFT JOIN transactions t ON t.account_id = a.id
        WHERE a.control_id = ?
        GROUP BY a.id, a.name, a.type, a.opening_balance
        ORDER BY a.name");
    $stmt->execute([$controlId]);
    $wallets = $stmt->fetchAll();

    return compact('messages', 'transactions', 'documents', 'wallets');
}

function add_message(PDO $pdo, int $userId, int $controlId, string $role, string $content): void
{
    $stmt = $pdo->prepare('INSERT INTO chat_messages (control_id, user_id, role, content) VALUES (?, ?, ?, ?)');
    $stmt->execute([$controlId, $userId, $role, $content]);
}

function add_transaction(PDO $pdo, int $userId, int $controlId, array $transaction): array
{
    $categoryId = ensure_category($pdo, $userId, $controlId, $transaction['category'], $transaction['kind']);
    $stmt = $pdo->prepare('INSERT INTO transactions (
        control_id, user_id, account_id, category_id, kind, status, amount, description, merchant, payment_method,
        transaction_date, due_date, source, raw_text, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $controlId,
        $userId,
        $transaction['accountId'] ?? null,
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

function add_document(PDO $pdo, int $userId, int $controlId, array $document): void
{
    $stmt = $pdo->prepare('INSERT INTO documents (control_id, user_id, original_name, stored_name, mime_type, status) VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([$controlId, $userId, $document['originalName'], $document['storedName'], $document['mimeType'], $document['status']]);
}

function serve_document(PDO $pdo, int $userId, int $controlId, string $id, array $env): void
{
    $stmt = $pdo->prepare('SELECT original_name AS originalName, stored_name AS storedName, mime_type AS mimeType FROM documents WHERE id = ? AND user_id = ? AND control_id = ? LIMIT 1');
    $stmt->execute([$id, $userId, $controlId]);
    $document = $stmt->fetch();
    if (!$document) {
        respond(['error' => 'Arquivo nao encontrado'], 404);
    }

    $objectName = document_object_name((string)$document['storedName']);
    $uploadRoot = realpath(__DIR__ . '/uploads');
    $content = null;
    $filePath = $uploadRoot !== false ? realpath($uploadRoot . DIRECTORY_SEPARATOR . $objectName) : false;
    if ($uploadRoot !== false && $filePath !== false && str_starts_with($filePath, $uploadRoot . DIRECTORY_SEPARATOR) && is_file($filePath)) {
        $content = file_get_contents($filePath);
    } elseif (str_starts_with((string)$document['storedName'], 'gs://')) {
        $content = download_from_google_cloud_storage($env, (string)$document['storedName']);
    }

    if ($content === null || $content === false) {
        respond(['error' => 'Arquivo indisponivel'], 404);
    }

    if (str_starts_with((string)$document['mimeType'], 'image/') && (string)($_GET['raw'] ?? '') !== '1') {
        serve_image_viewer($id, $document);
    }

    $filename = str_replace(['"', "\r", "\n"], '', (string)$document['originalName']);
    header('Content-Type: ' . ((string)$document['mimeType'] ?: 'application/octet-stream'));
    header('Content-Disposition: inline; filename="' . $filename . '"');
    header('Cache-Control: private, max-age=120');
    echo $content;
    exit;
}

function serve_image_viewer(string $id, array $document): void
{
    $filename = htmlspecialchars((string)($document['originalName'] ?? 'Imagem'), ENT_QUOTES, 'UTF-8');
    $imageUrl = '/api/documents/' . rawurlencode($id) . '/view?raw=1';
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: private, max-age=120');
    echo '<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>' . $filename . '</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; color: #fff; background: #101512; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .viewer { display: grid; min-height: 100dvh; padding: calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom)); place-items: center; }
    button { position: fixed; top: calc(10px + env(safe-area-inset-top)); right: 10px; z-index: 2; width: 42px; height: 42px; border: 1px solid rgba(255,255,255,.34); border-radius: 999px; color: #fff; background: rgba(16,21,18,.72); font: inherit; font-size: 1.35rem; font-weight: 800; line-height: 1; backdrop-filter: blur(8px); }
    img { max-width: 100%; max-height: calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); object-fit: contain; border-radius: 8px; background: #fff; }
  </style>
</head>
<body>
  <div class="viewer">
    <button type="button" aria-label="Fechar" title="Fechar" onclick="window.close(); if (!window.closed) history.back();">×</button>
    <img src="' . htmlspecialchars($imageUrl, ENT_QUOTES, 'UTF-8') . '" alt="' . $filename . '" />
  </div>
</body>
</html>';
    exit;
}

function download_from_google_cloud_storage(array $env, string $storedName): ?string
{
    $parsed = parse_google_storage_uri($storedName);
    if ($parsed === null) {
        return null;
    }
    $credentials = load_google_credentials($env);
    if ($credentials === null || !function_exists('curl_init')) {
        return null;
    }

    $token = google_access_token($credentials);
    $url = 'https://storage.googleapis.com/storage/v1/b/' . rawurlencode($parsed['bucket']) . '/o/' . rawurlencode($parsed['objectName']) . '?alt=media';
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer {$token}"],
        CURLOPT_TIMEOUT => 30,
    ]);
    $content = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    return $content !== false && $status >= 200 && $status < 300 ? (string)$content : null;
}

function parse_google_storage_uri(string $storedName): ?array
{
    if (!str_starts_with($storedName, 'gs://')) {
        return null;
    }
    $withoutScheme = substr($storedName, 5);
    $parts = explode('/', $withoutScheme);
    $bucket = array_shift($parts);
    $objectName = implode('/', $parts);
    return $bucket && $objectName ? ['bucket' => $bucket, 'objectName' => $objectName] : null;
}

function document_object_name(string $storedName): string
{
    if (str_starts_with($storedName, 'gs://')) {
        $withoutScheme = substr($storedName, 5);
        $parts = explode('/', $withoutScheme);
        array_shift($parts);
        return implode('/', $parts);
    }
    return $storedName;
}

function update_document_status(PDO $pdo, int $userId, int $controlId, int $documentId, string $status): void
{
    $stmt = $pdo->prepare('UPDATE documents SET status = ? WHERE id = ? AND user_id = ? AND control_id = ?');
    $stmt->execute([$status, $documentId, $userId, $controlId]);
}

function update_document_name(PDO $pdo, int $userId, int $controlId, int $documentId, string $originalName): void
{
    $stmt = $pdo->prepare('UPDATE documents SET original_name = ? WHERE id = ? AND user_id = ? AND control_id = ?');
    $stmt->execute([$originalName, $documentId, $userId, $controlId]);
}

function document_name_from_transaction(string $description, string $originalName): string
{
    $extension = pathinfo($originalName, PATHINFO_EXTENSION);
    $safeExtension = $extension !== '' ? strtolower(preg_replace('/[^a-zA-Z0-9]/', '', $extension)) : 'jpg';
    $base = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $description);
    $base = $base === false ? $description : $base;
    $base = preg_replace('/[^a-zA-Z0-9 -]/', '', $base) ?: 'Comprovante';
    $base = trim(preg_replace('/\s+/', ' ', $base));
    $base = mb_substr($base !== '' ? $base : 'Comprovante', 0, 80);
    return "{$base}.{$safeExtension}";
}

function update_transaction_status(PDO $pdo, int $userId, int $controlId, string $id, string $status): ?array
{
    $stmt = $pdo->prepare('UPDATE transactions SET status = ? WHERE id = ? AND user_id = ? AND control_id = ?');
    $stmt->execute([$status, $id, $userId, $controlId]);
    $data = read_data($pdo, $userId, $controlId);
    foreach ($data['transactions'] as $transaction) {
        if ($transaction['id'] === $id) {
            return $transaction;
        }
    }
    return null;
}

function update_transaction(PDO $pdo, int $userId, int $controlId, string $id, array $changes): ?array
{
    $categoryId = ensure_category($pdo, $userId, $controlId, $changes['category'], $changes['kind']);
    $stmt = $pdo->prepare('UPDATE transactions
        SET kind = ?,
            category_id = ?,
            amount = ?,
            description = ?,
            merchant = ?,
            payment_method = ?,
            account_id = ?,
            transaction_date = ?,
            due_date = ?
        WHERE id = ? AND user_id = ? AND control_id = ? AND status = ?');
    $stmt->execute([
        $changes['kind'],
        $categoryId,
        $changes['amount'],
        $changes['description'],
        $changes['merchant'],
        $changes['paymentMethod'],
        $changes['accountId'],
        $changes['transactionDate'],
        $changes['dueDate'],
        $id,
        $userId,
        $controlId,
        'pending',
    ]);

    $data = read_data($pdo, $userId, $controlId);
    foreach ($data['transactions'] as $transaction) {
        if ($transaction['id'] === $id) {
            return $transaction;
        }
    }
    return null;
}

function ensure_category(PDO $pdo, int $userId, int $controlId, string $name, string $kind): int
{
    $categoryKind = $kind === 'income' ? 'income' : 'expense';
    $stmt = $pdo->prepare('INSERT IGNORE INTO categories (control_id, user_id, name, kind) VALUES (?, ?, ?, ?)');
    $stmt->execute([$controlId, $userId, $name ?: 'Outros', $categoryKind]);
    $stmt = $pdo->prepare('SELECT id FROM categories WHERE control_id = ? AND name = ? AND kind = ? LIMIT 1');
    $stmt->execute([$controlId, $name ?: 'Outros', $categoryKind]);
    return (int)$stmt->fetchColumn();
}

function build_state(array $data, array $sessionPayload): array
{
    $month = date('Y-m');
    $confirmed = array_values(array_filter($data['transactions'], fn($item) => in_array($item['status'], ['confirmed', 'paid', 'scheduled'], true)));
    $pending = array_values(array_filter($data['transactions'], fn($item) => $item['status'] === 'pending'));
    $monthTransactions = array_values(array_filter($confirmed, fn($item) => str_starts_with($item['transactionDate'], $month)));
    $income = sum_items(array_filter($monthTransactions, fn($item) => $item['kind'] === 'income'));
    $expenses = sum_items(array_filter($monthTransactions, fn($item) => $item['kind'] === 'expense'));
    $payable = array_values(array_filter($confirmed, fn($item) => $item['status'] === 'scheduled'));
    $expenseCategories = group_by_category($monthTransactions, 'expense');
    $incomeCategories = group_by_category($monthTransactions, 'income');

    return [
        'messages' => $data['messages'],
        'transactions' => $confirmed,
        'pendingTransactions' => $pending,
        'documents' => $data['documents'],
        'wallets' => $data['wallets'] ?? [],
        'session' => $sessionPayload,
        'summary' => [
            'income' => $income,
            'expenses' => $expenses,
            'result' => round($income - $expenses, 2),
            'payableTotal' => sum_items($payable),
            'payableCount' => count($payable),
            'categories' => $expenseCategories,
            'expenseCategories' => $expenseCategories,
            'incomeCategories' => $incomeCategories,
            'monthlySeries' => build_monthly_series($confirmed),
        ],
    ];
}

function process_financial_message(PDO $pdo, int $userId, int $controlId, string $message, array $env): array
{
    add_message($pdo, $userId, $controlId, 'user', $message);
    $data = read_data($pdo, $userId, $controlId);
    $assistantResult = run_financial_assistant($message, $data, $env);

    if (($assistantResult['kind'] ?? '') === 'transactions') {
        $saved = [];
        foreach ($assistantResult['transactions'] as $transaction) {
            $transaction['status'] = 'pending';
            $saved[] = add_transaction($pdo, $userId, $controlId, $transaction);
        }
        $assistant = count($saved) > 1
            ? summarize_transactions($saved) . ' Confira os dados e confirme para salvar nos relatorios.'
            : summarize_transaction($saved[0]) . ' Confira os dados e confirme para salvar nos relatorios.';
    } elseif (($assistantResult['kind'] ?? '') === 'answer') {
        $assistant = (string)$assistantResult['answer'];
    } else {
        $parsed = parse_financial_message($message, $env);
        if ($parsed['intent'] === 'transaction') {
            $transactions = $parsed['transactions'] ?? [$parsed['transaction']];
            $saved = [];
            foreach ($transactions as $transaction) {
                $transaction['status'] = 'pending';
                $saved[] = add_transaction($pdo, $userId, $controlId, $transaction);
            }
            $assistant = count($saved) > 1
                ? summarize_transactions($saved) . ' Confira os dados e confirme para salvar nos relatorios.'
                : summarize_transaction($saved[0]) . ' Confira os dados e confirme para salvar nos relatorios.';
        } else {
            $assistant = answer_analytical_question($message, $data) ?: $parsed['answer'];
        }
    }

    add_message($pdo, $userId, $controlId, 'assistant', $assistant);
    return build_state(
        read_data($pdo, $userId, $controlId),
        session_payload($pdo, ['user_id' => $userId, 'active_control_id' => $controlId])
    );
}

function transcribe_audio_with_openai(string $path, string $mimeType, string $filename, array $env): string
{
    $apiKey = trim((string)($env['OPENAI_API_KEY'] ?? ''));
    if ($apiKey === '' || !function_exists('curl_init')) {
        throw new RuntimeException('A transcrição de áudio ainda não está configurada.');
    }

    $baseUrl = rtrim((string)($env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'), '/');
    $model = trim((string)($env['OPENAI_TRANSCRIBE_MODEL'] ?? 'gpt-4o-mini-transcribe')) ?: 'gpt-4o-mini-transcribe';
    $curl = curl_init("{$baseUrl}/audio/transcriptions");
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer {$apiKey}"],
        CURLOPT_POSTFIELDS => [
            'file' => new CURLFile($path, $mimeType, $filename),
            'model' => $model,
            'prompt' => 'Português do Brasil. Mensagem sobre finanças pessoais, compras, contas, vencimentos, parcelas, Pix e valores em reais.',
        ],
        CURLOPT_TIMEOUT => 45,
    ]);
    $raw = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) {
        throw new RuntimeException('Não consegui transcrever o áudio agora.');
    }
    $payload = json_decode((string)$raw, true);
    return trim((string)($payload['text'] ?? ''));
}

function run_financial_assistant(string $message, array $data, array $env): ?array
{
    $apiKey = trim((string)($env['OPENAI_API_KEY'] ?? ''));
    if ($apiKey === '' || !function_exists('curl_init')) return null;

    $baseUrl = rtrim((string)($env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'), '/');
    $model = trim((string)($env['OPENAI_CHAT_MODEL'] ?? 'gpt-4.1-mini')) ?: 'gpt-4.1-mini';
    $history = array_slice(array_values(array_filter($data['messages'] ?? [], function ($item) {
        return in_array($item['role'] ?? '', ['user', 'assistant'], true) && trim((string)($item['content'] ?? '')) !== '';
    })), -12);
    $input = array_map(fn($item) => [
        'role' => $item['role'],
        'content' => mb_substr((string)$item['content'], 0, 2000),
    ], $history);
    $last = $input ? $input[count($input) - 1] : null;
    if (!$last || $last['role'] !== 'user' || $last['content'] !== $message) {
        $input[] = ['role' => 'user', 'content' => $message];
    }

    try {
        for ($turn = 0; $turn < 4; $turn++) {
            $payload = openai_response_request($baseUrl, $apiKey, [
                'model' => $model,
                'store' => false,
                'instructions' => financial_assistant_instructions(),
                'input' => $input,
                'tools' => financial_assistant_tools(),
                'tool_choice' => 'auto',
                'parallel_tool_calls' => false,
                'max_output_tokens' => 1200,
            ]);
            if ($payload === null) return null;

            $calls = array_values(array_filter($payload['output'] ?? [], fn($item) => ($item['type'] ?? '') === 'function_call'));
            if (!$calls) {
                $answer = financial_response_text($payload);
                return $answer !== '' ? ['kind' => 'answer', 'answer' => $answer] : null;
            }

            foreach ($payload['output'] ?? [] as $item) $input[] = $item;
            foreach ($calls as $call) {
                $args = json_decode((string)($call['arguments'] ?? '{}'), true);
                $args = is_array($args) ? $args : [];

                if (($call['name'] ?? '') === 'propose_transactions') {
                    $transactions = [];
                    foreach (($args['transactions'] ?? []) as $transaction) {
                        if (!is_array($transaction)) continue;
                        $normalized = normalize_ai_transaction($transaction, $message, date('Y-m-d'));
                        if ($normalized !== null) $transactions[] = $normalized;
                        if (count($transactions) >= 60) break;
                    }
                    $recurrenceCount = extract_recurrence_count(normalize_text($message));
                    if ($recurrenceCount !== null && $transactions) {
                        $first = $transactions[0];
                        $baseDescription = preg_replace('/\s+\(\d+\/\d+\)$/', '', (string)$first['description']);
                        $transactions = [];
                        for ($index = 0; $index < $recurrenceCount; $index++) {
                            $occurrence = $first;
                            $occurrence['description'] = mb_substr("{$baseDescription} (" . ($index + 1) . "/{$recurrenceCount})", 0, 160);
                            $occurrence['transactionDate'] = add_months_to_iso_date($first['transactionDate'], $index);
                            $occurrence['dueDate'] = $first['dueDate'] ? add_months_to_iso_date($first['dueDate'], $index) : null;
                            $transactions[] = $occurrence;
                        }
                    }
                    if (!$transactions) {
                        return ['kind' => 'answer', 'answer' => 'Não consegui identificar todos os dados do lançamento. Qual é o valor e a data?'];
                    }
                    return ['kind' => 'transactions', 'transactions' => $transactions];
                }

                if (($call['name'] ?? '') === 'query_finances') {
                    $input[] = [
                        'type' => 'function_call_output',
                        'call_id' => (string)$call['call_id'],
                        'output' => json_encode(analyze_transactions_for_assistant($data['transactions'] ?? [], $args), JSON_UNESCAPED_UNICODE),
                    ];
                }
            }
        }
    } catch (Throwable $error) {
        if (($env['DEBUG_AI'] ?? '') === 'true') error_log('Financial assistant failed: ' . $error->getMessage());
    }
    return null;
}

function openai_response_request(string $baseUrl, string $apiKey, array $body): ?array
{
    $curl = curl_init("{$baseUrl}/responses");
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', "Authorization: Bearer {$apiKey}"],
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT => 25,
    ]);
    $raw = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) return null;
    $payload = json_decode((string)$raw, true);
    return is_array($payload) ? $payload : null;
}

function financial_assistant_instructions(): string
{
    $today = date('Y-m-d');
    return "Você é o assistente financeiro pessoal do Finup e conversa em português do Brasil. "
        . "Hoje é {$today}, no fuso America/Recife. Interprete datas relativas usando essa referência. "
        . 'Use propose_transactions quando o usuário quiser registrar receitas, despesas, contas, parcelas ou recorrências. '
        . 'Nunca invente valor, data, categoria ou recorrência. Se faltar um dado essencial, pergunte de forma curta. '
        . 'Forma de pagamento e estabelecimento são opcionais: use null e não faça outra pergunta apenas por esses campos. '
        . 'Compras em mercado, supermercado, mercadinho ou mercearia pertencem à categoria Mercado, mesmo quando o item é alimento. '
        . 'Em recorrências e parcelamentos, envie uma transação para cada ocorrência, com datas calculadas e descrições curtas. '
        . "Expressões como por 3 meses, 3 parcelas ou 3x são mensais: calcule a primeira data e avance um mês de calendário por ocorrência, preservando o dia quando possível. "
        . 'Uma conta futura deve ter dueDate e transactionDate na data informada. Uma compra já feita normalmente não tem dueDate. '
        . 'Use query_finances para responder qualquer pergunta sobre lançamentos, totais, períodos, categorias, comparações ou contas a pagar. '
        . 'Para contas a pagar use status scheduled e date_basis due. Para comparar meses, consulte o intervalo completo e agrupe por month. '
        . 'Não afirme que registrou algo antes de chamar propose_transactions. Os lançamentos propostos ainda serão confirmados pelo usuário. '
        . 'Responda de forma objetiva, amigável e fácil de ler no celular. Mostre valores em reais e datas em DD/MM/AAAA. '
        . 'Não exponha JSON, nomes de ferramentas, IDs internos ou detalhes técnicos.';
}

function financial_assistant_tools(): array
{
    $nullableString = ['type' => ['string', 'null']];
    return [
        [
            'type' => 'function', 'name' => 'propose_transactions',
            'description' => 'Propõe um ou mais lançamentos financeiros para revisão e confirmação do usuário.', 'strict' => true,
            'parameters' => [
                'type' => 'object',
                'properties' => ['transactions' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'kind' => ['type' => 'string', 'enum' => ['income', 'expense']],
                            'amount' => ['type' => 'number'], 'description' => ['type' => 'string'],
                            'merchant' => $nullableString,
                            'paymentMethod' => ['type' => ['string', 'null'], 'enum' => ['Pix', 'Cartao', 'Dinheiro', 'Boleto', null]],
                            'transactionDate' => ['type' => 'string', 'format' => 'date'],
                            'dueDate' => ['type' => ['string', 'null'], 'format' => 'date'],
                            'category' => ['type' => 'string', 'enum' => ['Mercado', 'Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Renda', 'Outros']],
                            'confidence' => ['type' => 'number'],
                        ],
                        'required' => ['kind', 'amount', 'description', 'merchant', 'paymentMethod', 'transactionDate', 'dueDate', 'category', 'confidence'],
                        'additionalProperties' => false,
                    ],
                ]],
                'required' => ['transactions'], 'additionalProperties' => false,
            ],
        ],
        [
            'type' => 'function', 'name' => 'query_finances',
            'description' => 'Consulta e agrega os lançamentos reais do controle financeiro ativo.', 'strict' => true,
            'parameters' => [
                'type' => 'object',
                'properties' => [
                    'kind' => ['type' => 'string', 'enum' => ['income', 'expense', 'all']],
                    'status' => ['type' => 'string', 'enum' => ['confirmed', 'paid', 'scheduled', 'all']],
                    'date_basis' => ['type' => 'string', 'enum' => ['transaction', 'due', 'auto']],
                    'start_date' => ['type' => ['string', 'null'], 'format' => 'date'],
                    'end_date' => ['type' => ['string', 'null'], 'format' => 'date'],
                    'category' => $nullableString, 'search' => $nullableString,
                    'group_by' => ['type' => 'string', 'enum' => ['none', 'month', 'category', 'status']],
                    'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50],
                ],
                'required' => ['kind', 'status', 'date_basis', 'start_date', 'end_date', 'category', 'search', 'group_by', 'limit'],
                'additionalProperties' => false,
            ],
        ],
    ];
}

function financial_response_text(array $payload): string
{
    $parts = [];
    foreach ($payload['output'] ?? [] as $item) {
        if (($item['type'] ?? '') !== 'message') continue;
        foreach ($item['content'] ?? [] as $content) {
            if (($content['type'] ?? '') === 'output_text' && isset($content['text'])) $parts[] = (string)$content['text'];
        }
    }
    return trim(implode("\n", $parts));
}

function analyze_transactions_for_assistant(array $transactions, array $filters): array
{
    $kind = in_array($filters['kind'] ?? '', ['income', 'expense', 'all'], true) ? $filters['kind'] : 'all';
    $status = in_array($filters['status'] ?? '', ['confirmed', 'paid', 'scheduled', 'all'], true) ? $filters['status'] : 'all';
    $dateBasis = in_array($filters['date_basis'] ?? '', ['transaction', 'due', 'auto'], true) ? $filters['date_basis'] : 'auto';
    $startDate = is_iso_date((string)($filters['start_date'] ?? '')) ? (string)$filters['start_date'] : null;
    $endDate = is_iso_date((string)($filters['end_date'] ?? '')) ? (string)$filters['end_date'] : null;
    $category = normalize_assistant_filter($filters['category'] ?? null);
    $search = normalize_assistant_filter($filters['search'] ?? null);
    $groupBy = in_array($filters['group_by'] ?? '', ['none', 'month', 'category', 'status'], true) ? $filters['group_by'] : 'none';
    $limit = max(1, min(50, (int)($filters['limit'] ?? 20)));

    $filtered = array_values(array_filter($transactions, function ($item) use ($kind, $status, $dateBasis, $startDate, $endDate, $category, $search) {
        if (!in_array($item['status'] ?? '', ['confirmed', 'paid', 'scheduled'], true)) return false;
        if ($kind !== 'all' && ($item['kind'] ?? '') !== $kind) return false;
        if ($status !== 'all' && ($item['status'] ?? '') !== $status) return false;
        if ($category !== '' && normalize_assistant_filter($item['category'] ?? '') !== $category) return false;
        if ($search !== '') {
            $haystack = normalize_assistant_filter(implode(' ', array_filter([$item['description'] ?? '', $item['merchant'] ?? '', $item['category'] ?? ''])));
            if (!str_contains($haystack, $search)) return false;
        }
        $date = assistant_transaction_date($item, $dateBasis);
        return (!$startDate || $date >= $startDate) && (!$endDate || $date <= $endDate);
    }));
    usort($filtered, fn($a, $b) => strcmp(assistant_transaction_date($a, $dateBasis), assistant_transaction_date($b, $dateBasis)));

    $income = round(array_reduce(array_filter($filtered, fn($item) => $item['kind'] === 'income'), fn($sum, $item) => $sum + (float)$item['amount'], 0), 2);
    $expenses = round(array_reduce(array_filter($filtered, fn($item) => $item['kind'] === 'expense'), fn($sum, $item) => $sum + (float)$item['amount'], 0), 2);
    $groups = [];
    if ($groupBy !== 'none') {
        foreach ($filtered as $item) {
            $key = $groupBy === 'month' ? substr(assistant_transaction_date($item, $dateBasis), 0, 7) : ($groupBy === 'category' ? (string)$item['category'] : (string)$item['status']);
            if (!isset($groups[$key])) $groups[$key] = ['key' => $key, 'count' => 0, 'income' => 0.0, 'expenses' => 0.0];
            $groups[$key]['count']++;
            $groups[$key][$item['kind'] === 'income' ? 'income' : 'expenses'] += (float)$item['amount'];
        }
    }
    $groups = array_values(array_map(function ($group) {
        $group['income'] = round($group['income'], 2); $group['expenses'] = round($group['expenses'], 2);
        $group['result'] = round($group['income'] - $group['expenses'], 2); return $group;
    }, $groups));

    $items = array_map(fn($item) => [
        'id' => (string)$item['id'], 'kind' => $item['kind'], 'status' => $item['status'], 'amount' => (float)$item['amount'],
        'description' => $item['description'], 'merchant' => $item['merchant'] ?: null, 'category' => $item['category'],
        'transaction_date' => $item['transactionDate'], 'due_date' => $item['dueDate'] ?: null,
    ], array_slice($filtered, 0, $limit));

    return [
        'filters' => ['kind' => $kind, 'status' => $status, 'date_basis' => $dateBasis, 'start_date' => $startDate, 'end_date' => $endDate, 'category' => $filters['category'] ?? null, 'search' => $filters['search'] ?? null, 'group_by' => $groupBy],
        'summary' => ['count' => count($filtered), 'income' => $income, 'expenses' => $expenses, 'result' => round($income - $expenses, 2)],
        'groups' => $groups, 'items' => $items, 'truncated' => count($filtered) > $limit,
    ];
}

function assistant_transaction_date(array $item, string $basis): string
{
    if ($basis === 'due' || ($basis === 'auto' && ($item['status'] ?? '') === 'scheduled')) return (string)($item['dueDate'] ?: $item['transactionDate']);
    return (string)$item['transactionDate'];
}

function normalize_assistant_filter(mixed $value): string
{
    return $value === null ? '' : trim(normalize_text((string)$value));
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
            'answer' => answer_missing_amount($normalized, extract_date($normalized)),
        ];
    }

    $kind = detect_kind($normalized);
    $date = extract_date($normalized);
    $isPayable = detect_payable($normalized, $kind, $date);

    $transaction = [
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
    ];
    $transactions = expand_recurring_transactions($transaction, $normalized);

    return [
        'intent' => 'transaction',
        'transaction' => $transactions[0],
        'transactions' => $transactions,
    ];
}

function parse_with_openai(string $text, array $env): ?array
{
    $apiKey = trim((string)($env['OPENAI_API_KEY'] ?? ''));
    if ($apiKey === '' || !function_exists('curl_init')) {
        return null;
    }

    $baseUrl = rtrim((string)($env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'), '/');
    $model = trim((string)($env['OPENAI_FALLBACK_MODEL'] ?? $env['OPENAI_MODEL'] ?? 'gpt-4.1-nano')) ?: 'gpt-4.1-nano';
    $today = date('Y-m-d');

    $body = [
        'model' => $model,
        'temperature' => 0,
        'response_format' => ['type' => 'json_object'],
        'messages' => [
            [
                'role' => 'system',
                'content' => 'Voce extrai dados financeiros pessoais de mensagens em portugues do Brasil. Responda somente JSON valido. Se houver transacao, use intent transaction. Nunca invente valor. Se nao houver valor monetario explicito, use intent question e peca o valor. Datas relativas como proxima quarta devem virar transactionDate e dueDate quando for conta, boleto ou fatura. Se a mensagem indicar recorrencia, parcelas ou duracao, retorne uma transacao por ocorrencia em transactions. Exemplos: por 3 meses, durante 3 meses, 3 parcelas, 3x geram 3 itens mensais. Se for pergunta ou texto sem valor financeiro, use intent question.',
            ],
            [
                'role' => 'user',
                'content' => json_encode([
                    'today' => $today,
                    'message' => $text,
                    'schema' => [
                        'intent' => 'transaction|question',
                        'answer' => 'string opcional para question',
                        'transactions' => 'array opcional de transaction quando houver recorrencia ou parcelas',
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

function parse_image_with_openai(string $path, string $mimeType, string $filename, array $env): ?array
{
    $apiKey = trim((string)($env['OPENAI_API_KEY'] ?? ''));
    if ($apiKey === '' || !str_starts_with($mimeType, 'image/') || !function_exists('curl_init')) {
        return null;
    }

    $content = file_get_contents($path);
    if ($content === false) {
        return null;
    }

    $baseUrl = rtrim((string)($env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'), '/');
    $model = trim((string)($env['OPENAI_OCR_MODEL'] ?? $env['OPENAI_MODEL'] ?? 'gpt-4.1-nano')) ?: 'gpt-4.1-nano';
    $today = date('Y-m-d');
    $dataUrl = 'data:' . $mimeType . ';base64,' . base64_encode($content);

    $body = [
        'model' => $model,
        'temperature' => 0,
        'response_format' => ['type' => 'json_object'],
        'messages' => [
            [
                'role' => 'system',
                'content' => 'Voce faz OCR e extrai dados financeiros de comprovantes, notas fiscais, prints de Pix, boletos e recibos brasileiros. Responda somente JSON valido. Se encontrar uma transacao, use intent transaction. Se nao encontrar valor financeiro, use intent question.',
            ],
            [
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'text',
                        'text' => json_encode([
                            'today' => $today,
                            'filename' => $filename,
                            'schema' => [
                                'intent' => 'transaction|question',
                                'answer' => 'string opcional para question',
                                'transaction' => [
                                    'kind' => 'income|expense',
                                    'amount' => 'number',
                                    'description' => 'string curta',
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
                    [
                        'type' => 'image_url',
                        'image_url' => ['url' => $dataUrl],
                    ],
                ],
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
        CURLOPT_TIMEOUT => 20,
    ]);

    $raw = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) {
        return null;
    }

    $payload = json_decode((string)$raw, true);
    $responseContent = $payload['choices'][0]['message']['content'] ?? null;
    if (!is_string($responseContent) || $responseContent === '') {
        return null;
    }

    $decoded = json_decode($responseContent, true);
    if (!is_array($decoded)) {
        return null;
    }

    $parsed = normalize_ai_result($decoded, "Arquivo: {$filename}", $today);
    if (($parsed['intent'] ?? '') === 'transaction') {
        $parsed['transaction']['source'] = 'upload';
    }
    return $parsed;
}

function normalize_ai_result(array $result, string $rawText, string $today): ?array
{
    if (($result['intent'] ?? '') !== 'transaction') {
        return [
            'intent' => 'question',
            'answer' => (string)($result['answer'] ?? 'Nao encontrei um valor financeiro nessa mensagem. Tente algo como: paguei R$ 89,90 no mercado hoje.'),
        ];
    }

    $normalizedRawText = normalize_text($rawText);
    if (!str_starts_with($rawText, 'Arquivo:') && extract_amount($normalizedRawText) === null) {
        return [
            'intent' => 'question',
            'answer' => answer_missing_amount($normalizedRawText, extract_date($normalizedRawText)),
        ];
    }

    $candidates = is_array($result['transactions'] ?? null) && count($result['transactions']) > 0
        ? $result['transactions']
        : [$result['transaction'] ?? []];
    $transactions = [];
    foreach ($candidates as $transaction) {
        if (is_array($transaction)) {
            $normalized = normalize_ai_transaction($transaction, $rawText, $today);
            if ($normalized !== null) {
                $transactions[] = $normalized;
            }
        }
    }
    if (count($transactions) === 0) {
        return null;
    }

    return [
        'intent' => 'transaction',
        'transaction' => $transactions[0],
        'transactions' => $transactions,
    ];
}

function normalize_ai_transaction(array $transaction, string $rawText, string $today): ?array
{
    $amount = (float)($transaction['amount'] ?? 0);
    if ($amount <= 0) {
        return null;
    }

    $kind = ($transaction['kind'] ?? '') === 'income' ? 'income' : 'expense';
    $transactionDate = is_iso_date((string)($transaction['transactionDate'] ?? '')) ? (string)$transaction['transactionDate'] : $today;
    $dueDate = is_iso_date((string)($transaction['dueDate'] ?? '')) ? (string)$transaction['dueDate'] : null;
    $detectedCategory = detect_category(normalize_text($rawText), $kind);
    $aiCategory = normalize_category((string)($transaction['category'] ?? ''), $kind);
    $category = $aiCategory === 'Outros' && $detectedCategory !== 'Outros' ? $detectedCategory : $aiCategory;

    return [
        'kind' => $kind,
        'status' => $dueDate && $kind === 'expense' ? 'scheduled' : 'confirmed',
        'amount' => $amount,
        'description' => mb_substr(trim((string)($transaction['description'] ?? $rawText)) ?: $rawText, 0, 160),
        'merchant' => trim((string)($transaction['merchant'] ?? '')) ?: null,
        'paymentMethod' => trim((string)($transaction['paymentMethod'] ?? '')) ?: null,
        'transactionDate' => $transactionDate,
        'dueDate' => $dueDate,
        'category' => $category,
        'source' => 'chat',
        'rawText' => $rawText,
        'confidence' => max(0, min(1, (float)($transaction['confidence'] ?? 0.8))),
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

function expand_recurring_transactions(array $transaction, string $text): array
{
    $count = extract_recurrence_count($text);
    if ($count === null || $count <= 1) {
        return [$transaction];
    }

    $transactions = [];
    for ($index = 0; $index < $count; $index++) {
        $copy = $transaction;
        $copy['description'] = mb_substr($transaction['description'] . ' (' . ($index + 1) . "/{$count})", 0, 160);
        $copy['transactionDate'] = add_months_to_iso_date($transaction['transactionDate'], $index);
        $copy['dueDate'] = $transaction['dueDate'] ? add_months_to_iso_date($transaction['dueDate'], $index) : null;
        $transactions[] = $copy;
    }
    return $transactions;
}

function extract_recurrence_count(string $text): ?int
{
    $patterns = [
        '/\bpor\s+(\d{1,2})\s+(?:mes|meses)\b/',
        '/\bdurante\s+(\d{1,2})\s+(?:mes|meses)\b/',
        '/\b(\d{1,2})\s+(?:parcelas|meses)\b/',
        '/\b(\d{1,2})x\b/',
    ];
    foreach ($patterns as $pattern) {
        if (preg_match($pattern, $text, $matches)) {
            $count = (int)$matches[1];
            return $count > 1 && $count <= 60 ? $count : null;
        }
    }
    return null;
}

function add_months_to_iso_date(string $isoDate, int $months): string
{
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $isoDate, new DateTimeZone('UTC'));
    if (!$date) {
        return $isoDate;
    }
    $day = (int)$date->format('d');
    $target = $date->modify('first day of +' . $months . ' month');
    $lastDay = (int)$target->format('t');
    return $target->setDate((int)$target->format('Y'), (int)$target->format('m'), min($day, $lastDay))->format('Y-m-d');
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
        'accountId' => trim((string)($body['accountId'] ?? '')) ?: null,
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
        '/\b(?:valor|de|gastei|paguei|comprei|recebi)\s+(\d{1,3}(?:\.\d{3})+|\d+)\b/i',
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

function detect_payable(string $text, string $kind, string $date): bool
{
    if ($kind !== 'expense') {
        return false;
    }
    if (preg_match('/\b(vence|vencimento|pagar|boleto|conta|fatura)\b/', $text)) {
        return true;
    }
    return $date > date('Y-m-d') && preg_match('/\b(pra|para|proxim[ao]|venc)\b/', $text);
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
    } else {
        $weekday = extract_weekday($text);
        if ($weekday !== null) {
            $current = (int)date('w', $timestamp);
            $diff = ($weekday - $current + 7) % 7;
            $timestamp = strtotime('+' . ($diff ?: 7) . ' day', $timestamp);
        }
    }
    return date('Y-m-d', $timestamp);
}

function extract_weekday(string $text): ?int
{
    if (!preg_match('/\b(proxim[ao]|pra|para|vence|vencimento)\b/', $text)) {
        return null;
    }
    $weekdays = [
        'domingo' => 0,
        'segunda' => 1,
        'terca' => 2,
        'terça' => 2,
        'quarta' => 3,
        'quinta' => 4,
        'sexta' => 5,
        'sabado' => 6,
        'sábado' => 6,
    ];
    foreach ($weekdays as $name => $index) {
        if (str_contains($text, $name)) {
            return $index;
        }
    }
    return null;
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

function summarize_transactions(array $transactions): string
{
    $first = $transactions[0];
    $last = $transactions[count($transactions) - 1];
    $sameAmount = count(array_filter($transactions, fn($item) => (float)$item['amount'] === (float)$first['amount'])) === count($transactions);
    $sameCategory = count(array_filter($transactions, fn($item) => $item['category'] === $first['category'])) === count($transactions);
    $sameKind = count(array_filter($transactions, fn($item) => $item['kind'] === $first['kind'])) === count($transactions);

    if ($sameAmount && $sameCategory && $sameKind) {
        $money = 'R$ ' . number_format((float)$first['amount'], 2, ',', '.');
        $type = $first['kind'] === 'income' ? 'receitas' : 'despesas';
        $hasDueDate = count(array_filter($transactions, fn($item) => !empty($item['dueDate']))) > 0;
        $label = $hasDueDate ? 'com vencimentos' : 'com datas';
        $startDate = date('d/m/Y', strtotime((string)($first['dueDate'] ?: $first['transactionDate'])));
        $endDate = date('d/m/Y', strtotime((string)($last['dueDate'] ?: $last['transactionDate'])));
        return "Registrei " . count($transactions) . " {$type} pendentes de {$money} em {$first['category']}, {$label} de {$startDate} a {$endDate}.";
    }

    return 'Registrei ' . count($transactions) . ' lancamentos pendentes.';
}

function normalize_text(string $text): string
{
    $lower = mb_strtolower($text, 'UTF-8');
    $converted = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $lower);
    return $converted === false ? $lower : $converted;
}

function answer_missing_amount(string $text, string $date): string
{
    if (preg_match('/\b(vence|vencimento|pagar|boleto|conta|fatura)\b/', $text) || extract_recurrence_count($text) !== null) {
        $when = $date ? ' para ' . date('d/m/Y', strtotime($date)) : '';
        $recurrence = extract_recurrence_count($text);
        $repeat = $recurrence ? " e repetindo por {$recurrence} meses" : '';
        return "Entendi a conta{$when}{$repeat}, mas preciso do valor para registrar. Exemplo: conta da internet de R$ 120 para proxima quarta por 10 meses.";
    }

    if (str_contains($text, 'quanto') || str_contains($text, 'gastei')) {
        return 'Ainda estou aprendendo a responder perguntas analiticas. Por enquanto, use o painel ao lado para acompanhar seus totais.';
    }
    return 'Nao encontrei um valor financeiro nessa mensagem. Tente algo como: paguei R$ 89,90 no mercado hoje.';
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

function group_by_category(array $items, string $kind = 'expense'): array
{
    $groups = [];
    foreach ($items as $item) {
        if ($item['kind'] !== $kind) {
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

function build_monthly_series(array $transactions): array
{
    $months = [];
    $start = new DateTimeImmutable('first day of -5 months');
    for ($index = 0; $index < 6; $index++) {
        $date = $start->modify("+{$index} months");
        $key = $date->format('Y-m');
        $months[$key] = [
            'key' => $key,
            'label' => $date->format('m/y'),
            'shortLabel' => $date->format('m'),
            'income' => 0.0,
            'expenses' => 0.0,
            'result' => 0.0,
        ];
    }

    foreach ($transactions as $transaction) {
        $key = substr((string)$transaction['transactionDate'], 0, 7);
        if (!isset($months[$key])) {
            continue;
        }
        if ($transaction['kind'] === 'income') {
            $months[$key]['income'] += (float)$transaction['amount'];
        } elseif ($transaction['kind'] === 'expense') {
            $months[$key]['expenses'] += (float)$transaction['amount'];
        }
    }

    return array_map(function ($item) {
        $item['income'] = round((float)$item['income'], 2);
        $item['expenses'] = round((float)$item['expenses'], 2);
        $item['result'] = round($item['income'] - $item['expenses'], 2);
        return $item;
    }, array_values($months));
}

function answer_analytical_question(string $message, array $data): ?string
{
    $text = normalize_text($message);
    $isPayableQuestion =
        preg_match('/\b(contas?|boletos?|faturas?|vencimentos?)\b/', $text) &&
        preg_match('/\b(pagar|vencer|vence|proxim[ao]s?)\b/', $text);
    if (!$isPayableQuestion) {
        return null;
    }

    $period = resolve_question_period($text);
    $items = array_values(array_filter($data['transactions'], function ($item) use ($period) {
        $date = (string)($item['dueDate'] ?: $item['transactionDate']);
        return $item['kind'] === 'expense'
            && $item['status'] === 'scheduled'
            && $date >= $period['start']
            && $date <= $period['end'];
    }));

    usort($items, fn($a, $b) => strcmp((string)($a['dueDate'] ?: $a['transactionDate']), (string)($b['dueDate'] ?: $b['transactionDate'])));

    if (count($items) === 0) {
        return "Voce nao tem contas agendadas para pagar {$period['label']}.";
    }

    $total = sum_items($items);
    $lines = array_map(function ($item) {
        $date = date('d/m', strtotime((string)($item['dueDate'] ?: $item['transactionDate'])));
        $money = 'R$ ' . number_format((float)$item['amount'], 2, ',', '.');
        return "{$date}: {$item['description']} ({$money})";
    }, array_slice($items, 0, 8));
    $extra = count($items) > 8 ? ' Tenho mais ' . (count($items) - 8) . ' alem dessas.' : '';
    $plural = count($items) > 1 ? 's' : '';
    $money = 'R$ ' . number_format($total, 2, ',', '.');

    return 'Voce tem ' . count($items) . " conta{$plural} para pagar {$period['label']}, totalizando {$money}. " . implode(' ', $lines) . $extra;
}

function resolve_question_period(string $text): array
{
    $today = date('Y-m-d');

    if (str_contains($text, 'hoje')) {
        return ['start' => $today, 'end' => $today, 'label' => 'hoje'];
    }
    if (str_contains($text, 'amanha')) {
        $tomorrow = date('Y-m-d', strtotime('+1 day'));
        return ['start' => $tomorrow, 'end' => $tomorrow, 'label' => 'amanha'];
    }
    if (str_contains($text, 'semana')) {
        return ['start' => $today, 'end' => date('Y-m-d', strtotime('+6 days')), 'label' => 'esta semana'];
    }

    return ['start' => $today, 'end' => date('Y-m-d', strtotime('+30 days')), 'label' => 'nos proximos 30 dias'];
}

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}
