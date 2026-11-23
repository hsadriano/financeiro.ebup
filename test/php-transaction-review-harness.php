<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/capture-requests.php';
require dirname(__DIR__) . '/app/transaction-review.php';

$wanted = ['connect_db', 'read_data', 'normalize_transaction', 'normalize_dates', 'add_message'];
$tokens = token_get_all(file_get_contents(dirname(__DIR__) . '/api.php'));
for ($i = 0; $i < count($tokens); $i++) {
    if (!is_array($tokens[$i]) || $tokens[$i][0] !== T_FUNCTION) continue;
    $code = 'function'; $name = ''; $depth = 0; $started = false;
    while (++$i < count($tokens)) {
        $token = $tokens[$i];
        $text = is_array($token) ? $token[1] : $token;
        if (!$name && is_array($token) && $token[0] === T_STRING) $name = $text;
        $code .= $text;
        if ($token === '{' || (is_array($token) && in_array($token[0], [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES], true))) { $depth++; $started = true; }
        if ($token === '}') $depth--;
        if ($started && $depth === 0) break;
    }
    if (in_array($name, $wanted, true)) eval($code);
}
if (getenv('FINUP_TEST_MARIADB') !== '1' || !in_array(getenv('DB_HOST'), ['localhost', '127.0.0.1', '::1'], true)) throw new RuntimeException('Only explicit local integration runs are allowed.');
$env = [];
foreach (['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS'] as $key) $env[$key] = getenv($key) ?: '';
$pdo = connect_db($env);
$pdo->exec(file_get_contents(__DIR__ . '/fixtures/transaction-move.sql'));
function check_review(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }

$pdo->exec("INSERT INTO transactions (id,control_id,user_id,category_id,kind,status,description,amount,transaction_date,due_date,source,confidence) VALUES (106,1,1,12,'expense','pending','Mercado',100,'2026-11-10',NULL,'upload',0.72),(107,1,1,12,'expense','pending','Taxi',35,'2026-11-20','2026-11-20','manual',1)");
$pdo->exec("INSERT INTO documents (id,control_id,user_id,original_name,stored_name) VALUES (301,1,1,'Mercado.pdf','private/market.pdf')");
link_transaction_document($pdo, 1, '106', '301');
$data = read_data($pdo, 1, 1);
$review = build_transaction_reviews($data)['106'];
check_review($review['duplicateIds'] === ['103'] && $review['documents'][0]['id'] === '301', 'Review metadata did not match the source space.');
check_review(confirm_reviewed_transactions($pdo, 1, 1, ['106','107'], [])['reviewRequired'], 'Duplicate capture saved without acknowledgement.');
check_review((int)$pdo->query("SELECT COUNT(*) FROM transactions WHERE id IN (106,107) AND status='pending'")->fetchColumn() === 2, 'Only part of the capture was left pending.');
check_review(confirm_reviewed_transactions($pdo, 1, 1, ['106','107'], ['103'])['confirmedCount'] === 2, 'Reviewed capture was not saved.');
check_review(confirm_reviewed_transactions($pdo, 1, 1, ['106','107'], [])['confirmedCount'] === 0, 'Retry saved the capture twice.');
$pdo->exec("INSERT INTO transactions (id,control_id,user_id,category_id,kind,status,description,amount,transaction_date) VALUES (108,1,1,12,'expense','pending','Mercado',100,'2026-11-10')");
check_review(confirm_reviewed_transactions($pdo, 1, 1, ['108'], ['103'])['reviewRequired'], 'A new candidate was ignored by a stale acknowledgement.');
$denied = false;
try { confirm_reviewed_transactions($pdo, 2, 1, ['104'], []); } catch (CaptureRequestError $error) { $denied = $error->getCode() === 403; }
check_review($denied, 'A viewer was able to confirm a capture.');
$pdo->exec('DELETE FROM transaction_documents');
backfill_document_links($pdo); backfill_document_links($pdo);
link_transaction_document($pdo, 1, '105', '201');
check_review((int)$pdo->query('SELECT COUNT(*) FROM transaction_documents')->fetchColumn() === 4 && (int)$pdo->query('SELECT COUNT(*) FROM transaction_documents WHERE transaction_id=105')->fetchColumn() === 0, 'Document link migration crossed a space boundary.');
$pdo->exec("INSERT INTO transactions (id,control_id,user_id,category_id,kind,status,description,amount,transaction_date) VALUES (110,1,1,12,'expense','pending','Livro especial',77,'2026-11-19')");
$pdo->exec("ALTER TABLE chat_messages ADD CONSTRAINT simulated_failure CHECK (content <> 'Lançamento salvo após conferência.')");
$failed = false;
try { confirm_reviewed_transactions($pdo, 1, 1, ['110'], []); } catch (PDOException $error) { $failed = true; }
check_review($failed && $pdo->query('SELECT status FROM transactions WHERE id=110')->fetchColumn() === 'pending', 'A failed confirmation was not rolled back.');
echo json_encode(['duplicates' => true, 'atomic' => true, 'idempotent' => true, 'stale' => true, 'scope' => true, 'links' => true]);
