<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/capture-requests.php';

$wanted = ['connect_db', 'move_transactions_to_control', 'expand_move_rows', 'normalize_assistant_filter', 'normalize_text'];
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
function verify(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }

$result = move_transactions_to_control($pdo, 1, 1, 2, ['ids' => ['101']]);
verify($result['movedCount'] === 2 && $result['movedDocumentCount'] === 1, 'Series was not moved entirely.');
$rows = $pdo->query('SELECT control_id, account_id, category_id, status FROM transactions WHERE id IN (101,102) ORDER BY id')->fetchAll();
verify((int)$rows[0]['control_id'] === 2 && (int)$rows[1]['control_id'] === 2 && (int)$rows[1]['account_id'] === 21 && (int)$rows[1]['category_id'] === 21 && $rows[0]['status'] === 'paid' && $rows[1]['status'] === 'scheduled', 'Financial metadata changed.');
$back = move_transactions_to_control($pdo, 1, 2, 1, ['ids' => ['102']]);
verify($back['movedDocumentCount'] === 1, 'Document did not follow a repeated move.');
$category = move_transactions_to_control($pdo, 1, 1, 2, ['ids' => ['103']]);
verify($category['unassignedWalletCount'] === 1 && $category['movedDocumentCount'] === 0, 'Partial-document handling failed.');
verify($pdo->query('SELECT c.name FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=103')->fetchColumn() === 'Mercado', 'Destination category was not mapped.');
$viewer = false;
try { move_transactions_to_control($pdo, 1, 1, 3, ['ids' => ['101']]); } catch (CaptureRequestError $error) { $viewer = $error->getCode() === 403; }
verify($viewer, 'Viewer destination was writable.');
$wallet = false;
try { move_transactions_to_control($pdo, 1, 1, 2, ['ids' => ['101'], 'walletMode' => 'specific', 'destinationAccountId' => '11']); } catch (CaptureRequestError $error) { $wallet = $error->getCode() === 400; }
verify($wallet, 'A wallet from the source was accepted at the destination.');
$pdo->beginTransaction();
move_transactions_to_control($pdo, 1, 1, 2, ['ids' => ['101']]);
verify($pdo->inTransaction(), 'Inner move committed the outer capture transaction.');
$pdo->rollBack();
verify((int)$pdo->query('SELECT control_id FROM transactions WHERE id=101')->fetchColumn() === 1, 'Outer rollback did not restore the series.');
$pdo->exec('ALTER TABLE transactions ADD CONSTRAINT simulated_failure CHECK (id <> 102 OR control_id <> 2)');
$failed = false;
try { move_transactions_to_control($pdo, 1, 1, 2, ['ids' => ['101']]); } catch (PDOException $error) { $failed = true; }
verify($failed && (int)$pdo->query('SELECT control_id FROM transactions WHERE id=101')->fetchColumn() === 1, 'Failed transfer left a partial update.');
echo json_encode(['series' => true, 'repeatedDocumentMove' => true, 'category' => true, 'viewer' => true, 'wallet' => true, 'rollback' => true]);
