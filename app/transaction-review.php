<?php
declare(strict_types=1);

function review_text(mixed $value): string
{
    $lower = mb_strtolower((string)($value ?? ''), 'UTF-8');
    $ascii = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $lower);
    $text = $ascii === false ? $lower : $ascii;
    $text = preg_replace('/\s*\(\d+\s*\/\s*\d+\)\s*$/', '', $text);
    return trim((string)preg_replace('/[^a-z0-9]+/', ' ', $text));
}

function review_tokens(mixed $value): array
{
    $ignored = array_fill_keys(['a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com', 'um', 'uma', 'r', 'rs', 'reais', 'compra', 'compras', 'pagamento', 'recebimento', 'despesa', 'receita', 'boleto', 'recibo', 'pix', 'cartao'], true);
    return array_fill_keys(array_values(array_filter(preg_split('/\s+/', review_text($value)), fn($word) => strlen($word) >= 3 && !isset($ignored[$word]) && !ctype_digit($word))), true);
}

function review_similar_description(mixed $left, mixed $right): bool
{
    $a = review_tokens($left);
    $b = review_tokens($right);
    if (!$a || !$b) return false;
    $common = count(array_intersect_key($a, $b));
    return ($common === count($a) && $common === count($b)) || ($common >= 2 && $common / min(count($a), count($b)) >= 0.75);
}

function review_financial_keys(array $item): array
{
    $amount = is_numeric($item['amount'] ?? null) ? (float)$item['amount'] : 0;
    if (!is_finite($amount) || $amount <= 0) return [];
    $cents = (int)round($amount * 100);
    $dates = array_unique(array_filter([$item['transactionDate'] ?? null, $item['dueDate'] ?? null], fn($day) => is_string($day) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)));
    return array_values(array_map(fn($day) => ($item['kind'] ?? '') . ':' . $cents . ':' . $day, $dates));
}

function review_public_document(array $document): array
{
    return ['id' => (string)$document['id'], 'originalName' => $document['originalName'], 'mimeType' => $document['mimeType'], 'status' => $document['status'], 'createdAt' => $document['createdAt']];
}

function build_transaction_reviews(array $data): array
{
    $items = array_values(array_filter($data['transactions'] ?? [], fn($item) => in_array($item['status'] ?? '', ['pending', 'confirmed', 'paid', 'scheduled'], true)));
    $documents = [];
    foreach ($data['documents'] ?? [] as $document) $documents[(string)$document['id']] = $document;
    $attachments = []; $byFinancialKey = []; $byHash = []; $byId = [];
    foreach ($items as $item) {
        $id = (string)$item['id'];
        $byId[$id] = $item;
        $attachments[$id] = [];
        foreach (array_unique(array_map('strval', $item['documentIds'] ?? [])) as $documentId) {
            if (!isset($documents[$documentId])) continue;
            $document = $documents[$documentId];
            $attachments[$id][] = $document;
            if (!empty($document['contentHash'])) $byHash[$document['contentHash']][$id] = true;
        }
        foreach (review_financial_keys($item) as $key) $byFinancialKey[$key][$id] = true;
    }

    $reviews = [];
    foreach ($items as $item) {
        $id = (string)$item['id'];
        $issues = []; $duplicates = [];
        if (($item['status'] ?? '') === 'pending') {
            $confidence = is_numeric($item['confidence'] ?? null) ? (float)$item['confidence'] : 0;
            if (($item['source'] ?? '') !== 'manual' && (!is_finite($confidence) || $confidence < 0.85)) {
                $issues[] = ['code' => 'check_interpretation', 'message' => ($item['source'] ?? '') === 'upload' ? 'A leitura precisa de conferência. Confira valor, data e situação.' : 'A interpretação precisa de conferência. Confira valor, data e situação.', 'fields' => ['amount', 'date', 'paymentState']];
            }
            if (($item['source'] ?? '') !== 'manual' && in_array(review_text($item['category'] ?? ''), ['', 'outros'], true)) {
                $issues[] = ['code' => 'check_category', 'message' => 'A categoria não foi identificada. Confira se Outros é a melhor opção.', 'fields' => ['category']];
            }
            $candidates = []; $sameFile = [];
            foreach (review_financial_keys($item) as $key) $candidates += $byFinancialKey[$key] ?? [];
            foreach ($attachments[$id] as $document) {
                $matches = !empty($document['contentHash']) ? ($byHash[$document['contentHash']] ?? []) : [];
                $candidates += $matches; $sameFile += $matches;
            }
            foreach ($candidates as $candidateId => $_) {
                $candidate = $byId[$candidateId];
                if ((string)$candidateId === $id || (!empty($item['recurrenceGroupId']) && $item['recurrenceGroupId'] === ($candidate['recurrenceGroupId'] ?? null))) continue;
                $merchant = review_text($item['merchant'] ?? '');
                $sameMerchant = strlen($merchant) >= 3 && $merchant === review_text($candidate['merchant'] ?? '');
                if (!isset($sameFile[$candidateId]) && !$sameMerchant && !review_similar_description($item['description'] ?? '', $candidate['description'] ?? '')) continue;
                $duplicates[] = ['id' => (string)$candidate['id'], 'description' => $candidate['description'], 'amount' => (float)$candidate['amount'], 'kind' => $candidate['kind'], 'status' => $candidate['status'], 'transactionDate' => $candidate['transactionDate'], 'dueDate' => $candidate['dueDate'] ?? null, 'reason' => isset($sameFile[$candidateId]) ? 'same_document' : 'matching_details'];
            }
            usort($duplicates, fn($a, $b) => (($a['status'] === 'pending') <=> ($b['status'] === 'pending')) ?: strnatcmp($a['id'], $b['id']));
        }
        $duplicateIds = array_column($duplicates, 'id');
        $reviews[$id] = ['documents' => array_map('review_public_document', $attachments[$id]), 'issues' => $issues, 'duplicateIds' => $duplicateIds, 'duplicates' => array_slice($duplicates, 0, 3), 'duplicateCount' => count($duplicateIds), 'needsAttention' => (bool)($issues || $duplicateIds)];
    }
    return $reviews;
}

function with_transaction_reviews(array $data): array
{
    $reviews = build_transaction_reviews($data);
    $data['transactions'] = array_map(fn($item) => array_merge($item, ['review' => $reviews[(string)$item['id']] ?? ['documents' => [], 'issues' => [], 'duplicateIds' => [], 'duplicates' => [], 'duplicateCount' => 0, 'needsAttention' => false]]), $data['transactions']);
    return $data;
}

function unreviewed_duplicate_ids(array $data, array $ids, array $reviewedIds = []): array
{
    $reviews = build_transaction_reviews($data);
    $reviewed = array_fill_keys(array_map('strval', $reviewedIds), true);
    $missing = [];
    foreach ($ids as $id) foreach ($reviews[(string)$id]['duplicateIds'] ?? [] as $duplicateId) if (!isset($reviewed[$duplicateId])) $missing[$duplicateId] = (string)$duplicateId;
    return array_values($missing);
}

function review_confirmation_ids(mixed $ids): array
{
    if (!is_array($ids) || !$ids || count($ids) > 100 || count(array_filter($ids, fn($id) => (is_int($id) || is_string($id)) && preg_match('/^\d{1,20}$/', (string)$id))) !== count($ids)) {
        throw new CaptureRequestError('Selecione de 1 a 100 lançamentos válidos para salvar.', 400);
    }
    return array_values(array_unique(array_map('strval', $ids)));
}

function link_transaction_document(PDO $pdo, int $controlId, string $transactionId, string $documentId): void
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO transaction_documents (transaction_id, document_id) SELECT t.id, d.id FROM transactions t INNER JOIN documents d ON d.id = ? AND d.control_id = t.control_id WHERE t.id = ? AND t.control_id = ?');
    $stmt->execute([$documentId, $transactionId, $controlId]);
}

function backfill_document_links(PDO $pdo): void
{
    $receipts = $pdo->query("SELECT capture_data FROM capture_requests WHERE operation = 'upload' AND capture_data IS NOT NULL AND JSON_VALID(capture_data)")->fetchAll();
    foreach ($receipts as $receipt) {
        $capture = json_decode((string)$receipt['capture_data'], true);
        $documentId = is_array($capture) ? (string)($capture['documentId'] ?? '') : '';
        if (!preg_match('/^\d{1,20}$/', $documentId)) continue;
        $ids = array_values(array_unique(array_filter(array_map('strval', is_array($capture['transactionIds'] ?? null) ? $capture['transactionIds'] : []), fn($id) => preg_match('/^\d{1,20}$/', $id))));
        if (!$ids) continue;
        $slots = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $pdo->prepare("INSERT IGNORE INTO transaction_documents (transaction_id, document_id) SELECT t.id, d.id FROM transactions t INNER JOIN documents d ON d.id = ? AND d.control_id = t.control_id WHERE t.id IN ({$slots})");
        $stmt->execute([$documentId, ...$ids]);
    }
}

function confirm_reviewed_transactions(PDO $pdo, int $userId, int $controlId, mixed $inputIds, mixed $reviewedIds): array
{
    $ids = review_confirmation_ids($inputIds);
    $reviewedIds = is_array($reviewedIds) ? array_values(array_filter($reviewedIds, fn($id) => is_string($id) || is_int($id))) : [];
    $ownsTransaction = !$pdo->inTransaction();
    if ($ownsTransaction) $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('SELECT id FROM financial_controls WHERE id = ? FOR UPDATE');
        $stmt->execute([$controlId]);
        $stmt = $pdo->prepare('SELECT role FROM control_members WHERE user_id = ? AND control_id = ?');
        $stmt->execute([$userId, $controlId]);
        if (!in_array($stmt->fetchColumn(), ['owner', 'editor'], true)) throw new CaptureRequestError('Você precisa ter permissão de edição para salvar lançamentos.', 403);
        $slots = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $pdo->prepare("SELECT CAST(id AS CHAR) AS id, status FROM transactions WHERE control_id = ? AND id IN ({$slots}) AND status <> 'dismissed' FOR UPDATE");
        $stmt->execute([$controlId, ...$ids]);
        $rows = $stmt->fetchAll();
        if (count($rows) !== count($ids)) throw new CaptureRequestError('Um ou mais lançamentos não foram encontrados neste espaço.', 404);
        $pendingIds = array_column(array_values(array_filter($rows, fn($row) => $row['status'] === 'pending')), 'id');
        if ($pendingIds && unreviewed_duplicate_ids(read_data($pdo, $userId, $controlId), $pendingIds, $reviewedIds)) {
            if ($ownsTransaction) $pdo->rollBack();
            return ['confirmedCount' => 0, 'reviewRequired' => true];
        }
        if ($pendingIds) {
            $stmt = $pdo->prepare("UPDATE transactions SET status = CASE WHEN due_date IS NOT NULL THEN 'scheduled' ELSE 'confirmed' END WHERE control_id = ? AND status = 'pending' AND id IN ({$slots})");
            $stmt->execute([$controlId, ...$ids]);
            add_message($pdo, $userId, $controlId, 'assistant', count($pendingIds) === 1 ? 'Lançamento salvo após conferência.' : count($pendingIds) . ' lançamentos salvos após conferência.');
        }
        if ($ownsTransaction) $pdo->commit();
        return ['confirmedCount' => count($pendingIds), 'reviewRequired' => false];
    } catch (Throwable $error) {
        if ($ownsTransaction && $pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}
