import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkXer, isXerDate, closeOfDay } from "../checks.js";

// A tiny XER built line by line, so line numbers in the assertions are easy to count.
const T = (...cells) => cells.join("\t");
function xer({ cal = [T("%R", "1", "Standard", "8", "Y")], tasks, preds = [] }) {
  return [
    T("ERMHDR", "19.12", "2026-11-12"),                                         // 1
    T("%T", "PROJECT"),                                                          // 2
    T("%F", "proj_id", "proj_short_name", "clndr_id"),                           // 3
    T("%R", "1", "TEST", "1"),                                                   // 4
    T("%T", "CALENDAR"),                                                         // 5
    T("%F", "clndr_id", "clndr_name", "day_hr_cnt", "default_flag"),             // 6
    ...cal,                                                                      // 7..
    T("%T", "TASK"),
    T("%F", "task_id", "task_code", "task_name", "task_type", "status_code", "clndr_id", "total_float_hr_cnt"),
    ...tasks.map((r) => T("%R", ...r)),
    T("%T", "TASKPRED"),
    T("%F", "task_pred_id", "task_id", "pred_task_id", "pred_type"),
    ...preds.map((r) => T("%R", ...r)),
    "%E",
  ].join("\n");
}
const task = (id, type = "TT_Task", tf = "0", status = "TK_NotStart", clndr = "1") => [id, "A" + id, "Act " + id, type, status, clndr, tf];

test("broken rows: wrong field count, duplicate id, missing task, unknown link type, bad date and number, each with its line", () => {
  const text = xer({
    tasks: [
      task("10", "TT_Mile"),                                 // line 10
      task("11"),                                            // 11
      task("11"),                                            // 12 duplicate task_id
      ["12", "A12", "Short row"],                            // 13 wrong field count
      task("13", "TT_Task", "lots"),                         // 14 bad number
    ],
    preds: [
      ["1", "11", "10", "PR_FS"],                            // 17
      ["2", "13", "99", "PR_FS"],                            // 18 pred task 99 missing
      ["3", "13", "11", "PR_XX"],                            // 19 unknown type
      ["1", "13", "11", "PR_FS"],                            // 20 duplicate task_pred_id
    ],
  });
  const { model } = checkXer(text);
  const got = model.breaks.map((b) => [b.line, b.kind]);
  assert.deepEqual(got, [
    [12, "duplicate id"],
    [13, "field count"],
    [14, "bad number"],
    [18, "missing reference"],
    [19, "unknown link type"],
    [20, "duplicate id"],
  ]);
  // Nothing vanished: every %R row is either used or listed as broken.
  const used = 1 + 1 + model.activities.length + model.rels.length;
  const setAside = model.breaks.filter((b) => !b.kept).length;
  assert.equal(used + setAside, model.rowCount);
});

test("bad dates are flagged by field and the row is kept", () => {
  assert.equal(isXerDate("2026-11-12 08:00"), true);
  assert.equal(isXerDate("2026-02-30 08:00"), false);
  assert.equal(isXerDate("2/12/2004 3:19:00 PM"), false);
  // Add a late_end_date column to the TASK table and give the one row a day-first date.
  const withDate = xer({ tasks: [task("1")] })
    .replace("total_float_hr_cnt", "total_float_hr_cnt\tlate_end_date")
    .replace(/(%R\t1\tA1\t[^\n]*)/, "$1\t31/12/2026");
  const { model } = checkXer(withDate);
  assert.equal(model.activities.length, 1);
  assert.equal(model.breaks.length, 1);
  assert.equal(model.breaks[0].kind, "bad date");
  assert.equal(model.breaks[0].kept, true);
  assert.match(model.breaks[0].reason, /late_end_date/);
});

test("missing links: open ends flagged, start and finish milestones allowed, completed and LOE skipped", () => {
  const { checks } = checkXer(xer({
    tasks: [
      task("1", "TT_Mile"),        // start milestone, no predecessor: fine
      task("2"),                   // linked both ways: fine
      task("3"),                   // no successor: flag
      task("4", "TT_FinMile"),     // finish milestone, no successor: fine
      task("5"),                   // no links at all: flag
      task("6", "TT_Task", "0", "TK_Complete"), // complete: skipped
      task("7", "TT_LOE"),         // level of effort: skipped
      task("8", "TT_Mile"),        // start milestone with no successor: flag
    ],
    preds: [["1", "2", "1", "PR_FS"], ["2", "3", "2", "PR_FS"], ["3", "4", "2", "PR_FS"]],
  }));
  assert.deepEqual(checks.openEnds.map((a) => [a.id, a.missing]), [
    ["3", "no successor"],
    ["5", "no predecessor or successor"],
    ["8", "no successor"],
  ]);
  assert.equal(checks.judged, 6);
});

test("negative float uses the file's total_float_hr_cnt", () => {
  const { checks } = checkXer(xer({ tasks: [task("1", "TT_Task", "-16"), task("2", "TT_Task", "0"), task("3", "TT_Task", "-0.5")] }));
  assert.deepEqual(checks.negative.map((a) => [a.id, a.tfDays]), [["1", -2], ["3", -0.1]]);
});

test("high float: hours become days with the calendar's day_hr_cnt, and the line is strict", () => {
  const cal = [T("%R", "1", "Standard", "8", "Y"), T("%R", "2", "Ten hour", "10", "N")];
  const { checks } = checkXer(xer({
    cal,
    tasks: [
      task("1", "TT_Task", "352"),        // 44 days on 8 h: not above the line
      task("2", "TT_Task", "360"),        // 45 days on 8 h: high
      task("3", "TT_Task", "440", "TK_NotStart", "2"), // 44 days on 10 h: not high
      task("4", "TT_Task", "450", "TK_NotStart", "2"), // 45 days on 10 h: high
    ],
  }));
  assert.deepEqual(checks.high.map((a) => [a.id, a.tfDays]), [["4", 45], ["2", 45]]);
});

test("hours per day falls back to the project calendar, then to 8", () => {
  const blank = checkXer(xer({ tasks: [task("1", "TT_Task", "80", "TK_NotStart", "")] })).model.activities[0];
  assert.equal(blank.hpd, 8);
  assert.match(blank.basis, /project calendar/);
  const none = checkXer(xer({ cal: [T("%R", "1", "Standard", "", "Y")], tasks: [task("1", "TT_Task", "80")] })).model.activities[0];
  assert.equal(none.hpd, 8);
  assert.match(none.basis, /fallback/);
});

test("closeOfDay: a finish at 08:00 or on a weekend closes the working day before", () => {
  assert.equal(closeOfDay("2026-11-16 08:00") - closeOfDay("2026-11-13 17:00"), 0); // Mon 08:00 = Fri close
  assert.equal(closeOfDay("2026-11-15 17:00") - closeOfDay("2026-11-13 17:00"), 0); // Sunday = Fri close
  assert.equal(closeOfDay("2026-11-17 17:00") - closeOfDay("2026-11-13 17:00"), 2);
});

// The two public files. These numbers were checked against the raw rows with awk, see NOTES-ai-mistakes.md.
const real = (f) => checkXer(readFileSync(new URL(`../samples/${f}`, import.meta.url), "utf8"));

test("aspose-testXer.xer: 12 bad calendar dates, 4 open ends, no negative float, 5 high float", () => {
  const { model, checks } = real("aspose-testXer.xer");
  assert.equal(model.activities.length, 83);
  assert.equal(model.rels.length, 86);
  assert.equal(model.breaks.length, 12);
  assert.ok(model.breaks.every((b) => b.table === "CALENDAR" && b.kind === "bad date" && b.kept));
  assert.equal(checks.openEnds.length, 4);
  assert.equal(checks.negative.length, 0);
  assert.equal(checks.high.length, 5);
  assert.deepEqual([checks.units.compared, checks.units.agree], [83, 83]);
});

test("hb-intel-Project_Schedule.xer: no broken rows, 32 open ends, no negative float, 11 high float", () => {
  const { model, checks } = real("hb-intel-Project_Schedule.xer");
  assert.equal(model.activities.length, 281);
  assert.equal(model.rels.length, 261);
  assert.equal(model.breaks.length, 0);
  assert.equal(checks.openEnds.length, 32);
  assert.equal(checks.negative.length, 0);
  assert.equal(checks.high.length, 11);
  assert.deepEqual([checks.units.compared, checks.units.agree], [281, 281]);
});
