<?php
declare(strict_types=1);

function plan_recurrence_change(array $transactions, array $options): array
{
    $scope = $options['scope'] ?? 'next';
    $action = $options['action'] ?? '';
    $anchorId = $options['anchorId'] ?? null;
    if (!in_array($scope, ['one', 'next', 'all'], true) || !in_array($action, ['cancel', 'reschedule'], true)) throw new CaptureRequestError('Operação de recorrência inválida.', 400);
    if ((!is_string($anchorId) && !is_int($anchorId)) || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/', (string)$anchorId)) throw new CaptureRequestError('Selecione uma parcela válida.', 400);
    $anchor = null;
    foreach ($transactions as $item) if ((string)$item['id'] === (string)$anchorId && $item['status'] !== 'dismissed') $anchor = $item;
    if (!$anchor || empty($anchor['recurrenceGroupId'])) throw new CaptureRequestError('A série recorrente não foi encontrada neste espaço.', 404);
    $day = $options['day'] ?? null;
    if ($action === 'reschedule' && (!is_numeric($day) || (float)$day !== (float)(int)$day || (int)$day < 1 || (int)$day > 31)) throw new CaptureRequestError('Informe um dia de vencimento entre 1 e 31.', 400);
    $selected = array_values(array_filter($transactions, function ($item) use ($anchor, $scope) {
        if (($item['recurrenceGroupId'] ?? null) !== $anchor['recurrenceGroupId'] || empty($item['dueDate']) || !in_array($item['status'], ['pending', 'scheduled'], true)) return false;
        if ($scope === 'one') return (string)$item['id'] === (string)$anchor['id'];
        if ($scope === 'all') return true;
        if (!empty($item['recurrenceIndex']) && !empty($anchor['recurrenceIndex'])) return (int)$item['recurrenceIndex'] >= (int)$anchor['recurrenceIndex'];
        return $item['dueDate'] >= ($anchor['dueDate'] ?: $anchor['transactionDate']);
    }));
    usort($selected, fn($a, $b) => strcmp($a['dueDate'], $b['dueDate']));
    if (count($selected) > 500) throw new CaptureRequestError('A série inclui mais de 500 parcelas em aberto. Divida a alteração em grupos menores.', 400);
    $changes = []; $items = [];
    foreach ($selected as $item) {
        $dueDate = null;
        if ($action === 'reschedule') {
            $parts = explode('-', $item['dueDate']);
            $year = (int)($parts[0] ?? 0); $month = (int)($parts[1] ?? 0);
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $item['dueDate']) || $year < 1000 || $month < 1 || $month > 12) throw new CaptureRequestError('Uma parcela tem vencimento inválido. Corrija a data antes de alterar a série.', 400);
            $first = new DateTimeImmutable(sprintf('%04d-%02d-01', $year, $month));
            $dueDate = sprintf('%04d-%02d-%02d', $year, $month, min((int)$day, (int)$first->format('t')));
            if ($item['dueDate'] === $dueDate && $item['transactionDate'] === $dueDate) continue;
        }
        $changes[] = $action === 'cancel' ? ['id' => (string)$item['id'], 'status' => 'dismissed'] : ['id' => (string)$item['id'], 'dueDate' => $dueDate, 'transactionDate' => $dueDate];
        $items[] = ['id' => (string)$item['id'], 'description' => ($item['description'] ?? '') ?: 'Parcela', 'kind' => ($item['kind'] ?? '') ?: 'expense', 'amount' => (float)($item['amount'] ?? 0), 'status' => $item['status'], 'oldDate' => $item['dueDate'], 'newDate' => $dueDate];
    }
    $preserved = count(array_filter($transactions, fn($item) => ($item['recurrenceGroupId'] ?? null) === $anchor['recurrenceGroupId'] && in_array($item['status'], ['paid', 'confirmed'], true)));
    return ['recurrenceGroupId' => $anchor['recurrenceGroupId'], 'action' => $action, 'changes' => $changes, 'items' => $items, 'count' => count($changes), 'preservedCount' => $preserved];
}

function manage_recurrence(PDO $pdo, int $userId, int $controlId, array $options, bool $apply = false): array
{
    $anchorId = $options['anchorId'] ?? null;
    if ((!is_string($anchorId) && !is_int($anchorId)) || !preg_match('/^\d{1,20}$/', (string)$anchorId)) throw new CaptureRequestError('Selecione uma parcela válida.', 400);
    $owns = !$pdo->inTransaction();
    if ($owns) $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('SELECT role FROM control_members WHERE user_id = ? AND control_id = ? FOR UPDATE');
        $stmt->execute([$userId, $controlId]);
        if (!in_array($stmt->fetchColumn(), ['owner', 'editor'], true)) throw new CaptureRequestError('Você precisa ter permissão de edição para alterar esta série.', 403);
        $stmt = $pdo->prepare('SELECT recurrence_group_id FROM transactions WHERE id = ? AND control_id = ?');
        $stmt->execute([$anchorId, $controlId]);
        $groupId = $stmt->fetchColumn();
        if (!$groupId) throw new CaptureRequestError('A série recorrente não foi encontrada neste espaço.', 404);
        $stmt = $pdo->prepare('SELECT CAST(id AS CHAR) AS id, recurrence_group_id AS recurrenceGroupId, recurrence_index AS recurrenceIndex, status, amount, description, kind, transaction_date AS transactionDate, due_date AS dueDate FROM transactions WHERE control_id = ? AND recurrence_group_id = ? ORDER BY id FOR UPDATE');
        $stmt->execute([$controlId, $groupId]);
        $plan = plan_recurrence_change($stmt->fetchAll(), $options);
        $token = hash('sha256', json_encode($plan, JSON_THROW_ON_ERROR));
        if ($apply) {
            if (!is_string($options['token'] ?? null) || !hash_equals($token, $options['token'])) throw new CaptureRequestError('A série mudou desde a prévia. Confira novamente antes de aplicar.', 409);
            if ($plan['action'] === 'cancel' && ($options['confirmCancellation'] ?? false) !== true) throw new CaptureRequestError('Confirme o cancelamento antes de aplicar.', 400);
            if (!$plan['count']) throw new CaptureRequestError('Não há parcelas em aberto para alterar nesta seleção.', 409);
            foreach ($plan['changes'] as $change) {
                $stmt = $pdo->prepare($plan['action'] === 'cancel'
                    ? "UPDATE transactions SET status = 'dismissed' WHERE id = ? AND control_id = ? AND status IN ('pending','scheduled') AND due_date IS NOT NULL"
                    : "UPDATE transactions SET transaction_date = ?, due_date = ? WHERE id = ? AND control_id = ? AND status IN ('pending','scheduled') AND due_date IS NOT NULL");
                $stmt->execute($plan['action'] === 'cancel' ? [$change['id'], $controlId] : [$change['transactionDate'], $change['dueDate'], $change['id'], $controlId]);
                if ($stmt->rowCount() !== 1) throw new CaptureRequestError('Uma parcela mudou durante a alteração. Nada foi aplicado; confira novamente.', 409);
            }
            $title = preg_replace('/\s+\(\d+\/\d+\)$/', '', $plan['items'][0]['description']);
            $quantity = $plan['count'] . ($plan['count'] === 1 ? ' parcela' : ' parcelas');
            add_message($pdo, $userId, $controlId, 'assistant', ($plan['action'] === 'cancel'
                ? 'Cancelei ' . $quantity . ' em aberto de “' . $title . '”.'
                : 'Atualizei o vencimento de ' . $quantity . ' em aberto de “' . $title . '”.') . ' Pagamentos anteriores foram preservados.');
        }
        if ($owns) $pdo->commit();
        return $apply ? ['action' => $plan['action'], 'changedCount' => $plan['count']] : array_merge($plan, ['token' => $token]);
    } catch (Throwable $error) {
        if ($owns && $pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}
