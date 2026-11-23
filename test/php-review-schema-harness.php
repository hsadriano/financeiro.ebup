<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/capture-requests.php';
require dirname(__DIR__) . '/app/transaction-review.php';
$wanted = ['connect_db', 'ensure_schema', 'apply_schema_updates', 'add_column_if_missing', 'migrate_default_control', 'ensure_category_unique_index', 'dedupe_categories', 'backfill_recurring_groups'];
$tokens = token_get_all(file_get_contents(dirname(__DIR__) . '/api.php'));
for ($i = 0; $i < count($tokens); $i++) {
    if (!is_array($tokens[$i]) || $tokens[$i][0] !== T_FUNCTION) continue;
    $code = 'function'; $name = ''; $depth = 0; $started = false;
    while (++$i < count($tokens)) {
        $token = $tokens[$i]; $text = is_array($token) ? $token[1] : $token;
        if (!$name && is_array($token) && $token[0] === T_STRING) $name = $text;
        $code .= $text;
        if ($token === '{' || (is_array($token) && in_array($token[0], [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES], true))) { $depth++; $started = true; }
        if ($token === '}') $depth--;
        if ($started && $depth === 0) break;
    }
    if (in_array($name, $wanted, true)) eval($code);
}
if (getenv('FINUP_TEST_MARIADB') !== '1' || !preg_match('/^finup_review_test_[a-f0-9]+$/', (string)getenv('DB_NAME')) || !in_array(getenv('DB_HOST'), ['localhost', '127.0.0.1', '::1'], true)) throw new RuntimeException('Schema validation only runs in its disposable local database.');
$env = [];
foreach (['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS'] as $key) $env[$key] = getenv($key) ?: '';
$pdo = connect_db($env);
ensure_schema($pdo); ensure_schema($pdo);
echo json_encode(['migrated' => true]);
