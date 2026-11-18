<?php
declare(strict_types=1);

final class CaptureRequestError extends RuntimeException {}

function capture_key(?string $value): ?string
{
    if ($value === null || $value === '') return null;
    if (!preg_match('/^[a-zA-Z0-9_-]{16,64}$/', $value)) throw new CaptureRequestError('Identificador de envio inválido.', 400);
    return $value;
}

function capture_fingerprint(string $operation, array $payload = [], ?array $file = null): string
{
    $content = $file
        ? hash_file('sha256', (string)$file['tmp_name']) . '|' . (string)$file['type'] . '|' . basename((string)$file['name'])
        : json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    return hash('sha256', $operation . '|' . $content);
}

function with_capture_request(PDO $pdo, int $userId, int $controlId, ?string $key, string $operation, string $fingerprint, callable $action, callable $replay): array
{
    $pdo->beginTransaction();
    try {
        if ($key !== null) {
            try {
                $stmt = $pdo->prepare('INSERT INTO capture_requests (user_id, control_id, request_key, operation, fingerprint) VALUES (?, ?, ?, ?, ?)');
                $stmt->execute([$userId, $controlId, $key, $operation, $fingerprint]);
            } catch (PDOException $error) {
                if ((int)($error->errorInfo[1] ?? 0) !== 1062) throw $error;
                $pdo->rollBack();
                $stmt = $pdo->prepare('SELECT operation, fingerprint, capture_data FROM capture_requests WHERE user_id = ? AND control_id = ? AND request_key = ?');
                $stmt->execute([$userId, $controlId, $key]);
                $previous = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$previous || $previous['operation'] !== $operation || !hash_equals($previous['fingerprint'], $fingerprint)) {
                    throw new CaptureRequestError('Este identificador já pertence a outro envio.', 409);
                }
                if (!$previous['capture_data']) throw new CaptureRequestError('Este envio ainda está em processamento. Tente novamente em instantes.', 409);
                return array_merge($replay(), ['capture' => array_merge(json_decode($previous['capture_data'], true, 512, JSON_THROW_ON_ERROR), ['replayed' => true])]);
            }
        }
        $result = $action();
        $messages = $result['messages'] ?? [];
        $capture = array_merge($result['capture'] ?? ['transactionIds' => []], [
            'requestId' => $key, 'messageId' => $operation !== 'manual' && $messages ? $messages[count($messages) - 1]['id'] : null,
        ]);
        if ($key !== null) {
            $stmt = $pdo->prepare('UPDATE capture_requests SET capture_data = ? WHERE user_id = ? AND control_id = ? AND request_key = ?');
            $stmt->execute([json_encode($capture, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), $userId, $controlId, $key]);
        }
        $pdo->commit();
        return array_merge($result, ['capture' => $capture]);
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}
