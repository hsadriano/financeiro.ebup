import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../api.php", import.meta.url));
test("PHP input contract matches the manual entry flow without opening a database", (t) => {
  const php = String.raw`
    $wanted = ['normalize_transaction_changes', 'normalize_date', 'add_months_to_iso_date', 'analyze_transactions_for_assistant', 'normalize_assistant_filter', 'assistant_transaction_date', 'is_iso_date'];
    $tokens = token_get_all(file_get_contents($argv[1]));
    for ($i = 0; $i < count($tokens); $i++) {
      if (!is_array($tokens[$i]) || $tokens[$i][0] !== T_FUNCTION) continue;
      $code = 'function'; $name = ''; $depth = 0; $started = false;
      while (++$i < count($tokens)) {
        $token = $tokens[$i];
        $text = is_array($token) ? $token[1] : $token;
        if (!$name && is_array($token) && $token[0] === T_STRING) $name = $text;
        $code .= $text;
        if ($token === '{') { $depth++; $started = true; }
        if ($token === '}') $depth--;
        if ($started && $depth === 0) break;
      }
      if (in_array($name, $wanted, true)) eval($code);
    }
    $input = ['amount' => '1.234,56', 'transactionDate' => '2026-01-31', 'dueDate' => '2026-01-31'];
    $normalized = normalize_transaction_changes($input);
    $invalidRejected = false;
    try { normalize_date('2026-02-31'); } catch (Throwable $error) { $invalidRejected = true; }
    $entry = ['id' => 'one', 'kind' => 'expense', 'status' => 'confirmed', 'amount' => 15, 'description' => 'Pão', 'merchant' => null, 'category' => 'Mercado', 'transactionDate' => '2026-11-18', 'dueDate' => null, 'accountName' => null, 'recurrenceGroupId' => null];
    $query = analyze_transactions_for_assistant([$entry, array_merge($entry, ['id' => 'future', 'status' => 'scheduled', 'amount' => 900])], ['status' => 'settled']);
    echo json_encode(['amount' => $normalized['amount'], 'date' => add_months_to_iso_date('2026-01-31', 1), 'invalidRejected' => $invalidRejected, 'settledTotal' => $query['summary']['expenses']]);
  `;
  const result = spawnSync("php", ["-r", php, apiPath], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("PHP runtime not available"); return; }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { amount: 1234.56, date: "2026-02-28", invalidRejected: true, settledTotal: 15 });
});
