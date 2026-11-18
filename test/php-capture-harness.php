<?php
declare(strict_types=1);
require __DIR__ . '/../app/capture-requests.php';

final class ReceiptDatabase extends PDO
{
    public array $rows = [];
    public array $financial = [];
    private ?array $backup = null;
    public function __construct() {}
    public function beginTransaction(): bool { $this->backup = [$this->rows, $this->financial]; return true; }
    public function commit(): bool { $this->backup = null; return true; }
    public function rollBack(): bool {
        if ($this->backup !== null) [$this->rows, $this->financial] = $this->backup;
        $this->backup = null;
        return true;
    }
    public function inTransaction(): bool { return $this->backup !== null; }
    public function prepare(string $query, array $options = []): PDOStatement|false { return new ReceiptStatement($this, $query); }
}
final class ReceiptStatement extends PDOStatement
{
    private mixed $result = false;
    public function __construct(private ReceiptDatabase $database, private string $sql) {}
    public function execute(?array $params = null): bool {
        if (str_starts_with($this->sql, 'INSERT')) {
            [$user, $control, $key, $operation, $fingerprint] = $params;
            $id = "$user:$control:$key";
            if (isset($this->database->rows[$id])) {
                $error = new PDOException('Duplicate'); $error->errorInfo = ['23000', 1062, 'Duplicate']; throw $error;
            }
            $this->database->rows[$id] = ['operation' => $operation, 'fingerprint' => $fingerprint, 'capture_data' => null];
        } elseif (str_starts_with($this->sql, 'UPDATE')) {
            [$data, $user, $control, $key] = $params;
            $this->database->rows["$user:$control:$key"]['capture_data'] = $data;
        } elseif (str_starts_with($this->sql, 'SELECT')) {
            $this->result = $this->database->rows[implode(':', $params)] ?? false;
        }
        return true;
    }
    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed { return $this->result; }
}

$db = new ReceiptDatabase();
$calls = 0;
$action = function () use ($db, &$calls) { $calls++; $db->financial[] = 'one'; return ['capture' => ['transactionIds' => ['one']]]; };
$replay = fn() => ['current' => true];
$key = capture_key('request-000000001');
with_capture_request($db, 1, 2, $key, 'manual', 'hash', $action, $replay);
$result = with_capture_request($db, 1, 2, $key, 'manual', 'hash', $action, $replay);
if ($calls !== 1 || count($db->financial) !== 1 || !$result['capture']['replayed']) throw new RuntimeException('Replay duplicated work');
$conflict = false;
try { with_capture_request($db, 1, 2, $key, 'manual', 'changed', $action, $replay); }
catch (CaptureRequestError $error) { $conflict = $error->getCode() === 409; }
if (!$conflict) throw new RuntimeException('Payload conflict was not rejected');
try {
    with_capture_request($db, 1, 2, 'request-000000002', 'manual', 'hash', function () use ($db) { $db->financial[] = 'partial'; throw new RuntimeException('Interrupted'); }, $replay);
} catch (RuntimeException $error) {}
if (count($db->financial) !== 1 || count($db->rows) !== 1) throw new RuntimeException('Rollback failed');
with_capture_request($db, 9, 2, $key, 'manual', 'hash', $action, $replay);
if ($calls !== 2) throw new RuntimeException('User scope was lost');
echo json_encode(['replay' => true, 'conflict' => true, 'rollback' => true, 'scope' => true]);
