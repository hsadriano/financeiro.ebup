import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../api.php", import.meta.url));
test("PHP input contract matches the manual entry flow without opening a database", (t) => {
  const php = String.raw`
    require dirname($argv[1]) . '/app/capture-requests.php';
    $wanted = ['normalize_transaction_changes', 'normalize_date', 'add_months_to_iso_date', 'analyze_transactions_for_assistant', 'normalize_assistant_filter', 'assistant_transaction_date', 'is_iso_date', 'build_pdf_ocr_payload', 'openai_response_output_text', 'normalize_pdf_ocr_result', 'expand_move_rows'];
    $tokens = token_get_all(file_get_contents($argv[1]));
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
    $input = ['amount' => '1.234,56', 'transactionDate' => '2026-01-31', 'dueDate' => '2026-01-31'];
    $normalized = normalize_transaction_changes($input);
    $invalidRejected = false;
    try { normalize_date('2026-02-31'); } catch (Throwable $error) { $invalidRejected = true; }
    $entry = ['id' => 'one', 'kind' => 'expense', 'status' => 'confirmed', 'amount' => 15, 'description' => 'Pão', 'merchant' => null, 'category' => 'Mercado', 'transactionDate' => '2026-11-18', 'dueDate' => null, 'accountName' => null, 'recurrenceGroupId' => null];
    $query = analyze_transactions_for_assistant([$entry, array_merge($entry, ['id' => 'future', 'status' => 'scheduled', 'amount' => 900])], ['status' => 'settled']);
    $pdfPayload = build_pdf_ocr_payload('gpt-4.1-nano', 'boleto.pdf', '2026-11-18', 'JVBERi0xLjQ=');
    $pdfFile = $pdfPayload['input'][1]['content'][1];
    $pdfText = openai_response_output_text(['output' => [['type' => 'message', 'content' => [['type' => 'output_text', 'text' => '{"intent":"question"}']]]]]);
    $pdfAmbiguous = normalize_pdf_ocr_result(['intent' => 'transaction', 'transaction' => ['kind' => 'expense', 'financialStatus' => 'unclear', 'amount' => 120, 'transactionDate' => '2026-11-18', 'confidence' => 0.95]], 'fatura.pdf', '2026-11-18');
    $moveRows = [['id' => '10', 'status' => 'confirmed', 'recurrenceGroupId' => 'school'], ['id' => '11', 'status' => 'scheduled', 'recurrenceGroupId' => 'school'], ['id' => '12', 'status' => 'paid', 'recurrenceGroupId' => null]];
    $moveIds = array_column(expand_move_rows($moveRows, ['10']), 'id');
    echo json_encode(['amount' => $normalized['amount'], 'date' => add_months_to_iso_date('2026-01-31', 1), 'invalidRejected' => $invalidRejected, 'settledTotal' => $query['summary']['expenses'], 'pdfModel' => $pdfPayload['model'], 'pdfStore' => $pdfPayload['store'], 'pdfFormat' => $pdfPayload['text']['format']['type'], 'pdfFilename' => $pdfFile['filename'], 'pdfData' => $pdfFile['file_data'], 'pdfDetail' => $pdfFile['detail'], 'pdfText' => $pdfText, 'pdfAmbiguousIntent' => $pdfAmbiguous['intent'], 'moveIds' => $moveIds]);
  `;
  const result = spawnSync("php", ["-r", php, apiPath], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("PHP runtime not available"); return; }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { amount: 1234.56, date: "2026-02-28", invalidRejected: true, settledTotal: 15, pdfModel: "gpt-4.1-nano", pdfStore: false, pdfFormat: "json_object", pdfFilename: "boleto.pdf", pdfData: "data:application/pdf;base64,JVBERi0xLjQ=", pdfDetail: "high", pdfText: '{"intent":"question"}', pdfAmbiguousIntent: "question", moveIds: ["10", "11"] });
});
