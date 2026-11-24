import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planRecurrenceChange, recurrenceToken } from "../src/recurrence-management.js";

const items = [
  { id: "1", recurrenceGroupId: "school", recurrenceIndex: 1, status: "paid", dueDate: "2026-01-10", transactionDate: "2026-01-10" },
  { id: "2", recurrenceGroupId: "school", recurrenceIndex: 2, status: "scheduled", dueDate: "2026-02-10", transactionDate: "2026-02-10" },
  { id: "3", recurrenceGroupId: "school", recurrenceIndex: 3, status: "pending", dueDate: "2026-03-10", transactionDate: "2026-03-10" },
  { id: "4", recurrenceGroupId: "other", recurrenceIndex: 1, status: "scheduled", dueDate: "2026-03-10", transactionDate: "2026-03-10" }
];

test("ending a series preserves paid items and unrelated series", () => {
  const plan = planRecurrenceChange(items, { anchorId: "2", action: "cancel", scope: "next" });
  assert.deepEqual(plan.changes, [{ id: "2", status: "dismissed" }, { id: "3", status: "dismissed" }]);
});
test("rescheduling clamps month-end dates without modifying payment history", () => {
  const plan = planRecurrenceChange(items, { anchorId: "1", action: "reschedule", scope: "all", day: 31 });
  assert.deepEqual(plan.changes.map((item) => item.dueDate), ["2026-02-28", "2026-03-31"]);
});
test("one occurrence scope does not alter later installments", () => {
  assert.equal(planRecurrenceChange(items, { anchorId: "2", action: "cancel", scope: "one" }).count, 1);
});
test("unknown series, invalid scopes and invalid days are rejected", () => {
  for (const options of [{ anchorId: "missing", action: "cancel" }, { anchorId: "2", action: "reschedule", day: 32 }, { anchorId: "2", action: "cancel", scope: "invalid" }]) assert.throws(() => planRecurrenceChange(items, options));
});

test("dates at month end honor leap years and do not rewrite unchanged installments", () => {
  const leap = items.map((item) => ({ ...item, dueDate: item.dueDate.replace("2026", "2028"), transactionDate: item.transactionDate.replace("2026", "2028") }));
  assert.equal(planRecurrenceChange(leap, { anchorId: "2", action: "reschedule", day: 31, scope: "one" }).changes[0].dueDate, "2028-02-29");
  assert.equal(planRecurrenceChange(items, { anchorId: "2", action: "reschedule", day: 10, scope: "all" }).count, 0);
});

test("preview tokens change when a target installment is paid or edited", () => {
  const options = { anchorId: "2", action: "cancel", scope: "next" };
  const token = recurrenceToken(planRecurrenceChange(items, options));
  const paid = items.map((item) => item.id === "3" ? { ...item, status: "paid" } : item);
  assert.notEqual(recurrenceToken(planRecurrenceChange(paid, options)), token);
  const changed = items.map((item) => item.id === "3" ? { ...item, amount: 1000 } : item);
  assert.notEqual(recurrenceToken(planRecurrenceChange(changed, options)), token);
});

test("settled drafts and removed installments are not canceled with open future bills", () => {
  const rows = [...items, { ...items[2], id: "5", dueDate: null, status: "pending" }, { ...items[2], id: "6", status: "dismissed" }];
  assert.deepEqual(planRecurrenceChange(rows, { anchorId: "1", action: "cancel", scope: "all" }).changes.map((item) => item.id), ["2", "3"]);
});

test("PHP and Node agree on recurrence previews", (t) => {
  const capture = fileURLToPath(new URL("../app/capture-requests.php", import.meta.url));
  const recurrence = fileURLToPath(new URL("../app/recurrence-management.php", import.meta.url));
  for (const options of [{ anchorId: "2", scope: "next", action: "cancel" }, { anchorId: "1", scope: "all", action: "reschedule", day: 31 }, { anchorId: "2", scope: "one", action: "reschedule", day: 10 }]) {
    const result = spawnSync("php", ["-r", 'require $argv[1]; require $argv[2]; $input=json_decode(stream_get_contents(STDIN),true); echo json_encode(plan_recurrence_change($input["items"],$input["options"]));', capture, recurrence], { encoding: "utf8", input: JSON.stringify({ items, options }) });
    if (result.error?.code === "ENOENT") { t.skip("PHP runtime unavailable"); return; }
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), planRecurrenceChange(items, options));
  }
});
