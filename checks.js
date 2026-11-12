// Turn parsed XER tables into activities and links, flag broken rows, and run
// three checks: missing links, negative float, high float. No DOM.

import { parseXer, brk } from "./xer.js";

/** DCMA 14-point assessment, check 6: total float above 44 working days is "high float". */
export const HIGH_FLOAT_DAYS = 44;
/** Used when no calendar in the file says how many hours make a working day. */
export const FALLBACK_HOURS_PER_DAY = 8;

const REL_TYPES = { PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" };
const TASK_TYPES = new Set(["TT_Task", "TT_Rsrc", "TT_Mile", "TT_FinMile", "TT_LOE", "TT_WBS"]);
const STATUSES = new Set(["TK_NotStart", "TK_Active", "TK_Complete"]);
const CHECKED_TABLES = ["PROJECT", "CALENDAR", "TASK", "TASKPRED"];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * True for "", or a real calendar date in XER form (yyyy-mm-dd, optional hh:mm[:ss]).
 * The day must exist (no 30 February), hours run 0 to 23, minutes and seconds 0 to 59.
 */
export function isXerDate(s) {
  if (s === "") return true;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
  const t = new Date(Date.UTC(+y, +mo - 1, +d));
  const realDay = t.getUTCFullYear() === +y && t.getUTCMonth() === +mo - 1 && t.getUTCDate() === +d;
  return realDay && +h <= 23 && +mi <= 59 && +sec <= 59;
}

/** Number or null. "" is null (no value). Anything unreadable, or too large to be finite (1e999), is NaN. */
export function xerNum(s) {
  if (s == null || s === "") return null;
  const t = s.trim();
  if (!NUM_RE.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const isDateField = (f) => /_date2?$/.test(f);
const isNumField = (f) => /(_hr_cnt|_qty|_pct)$/.test(f);

/** Every date and number field in the tables we read must parse. Bad values are flagged; the row is kept. */
function valueBreaks(parsed) {
  const out = [];
  for (const t of CHECKED_TABLES) {
    for (const { line, rec } of parsed.tables[t]?.rows || []) {
      for (const [f, v] of Object.entries(rec)) {
        if (isDateField(f) && !isXerDate(v.trim())) out.push(brk(line, t, "bad date", `${f} is "${v}", not a date in XER form (yyyy-mm-dd hh:mm). Kept the row, ignored the value.`, true));
        else if (isNumField(f) && Number.isNaN(xerNum(v))) out.push(brk(line, t, "bad number", `${f} is "${v}", not a number. Kept the row, ignored the value.`, true));
      }
    }
  }
  return out;
}

/**
 * Build the schedule: calendars, activities, links, and every broken row with its line.
 * Each activity carries the hours per day used to turn its float into days, and where that figure came from.
 */
export function buildModel(parsed) {
  const breaks = [...parsed.breaks, ...valueBreaks(parsed)];

  const calendars = new Map();
  for (const { line, rec } of parsed.tables.CALENDAR?.rows || []) {
    const id = rec.clndr_id;
    if (!id) { breaks.push(brk(line, "CALENDAR", "missing id", "Calendar with no clndr_id. Set aside.")); continue; }
    if (calendars.has(id)) { breaks.push(brk(line, "CALENDAR", "duplicate id", `Calendar id ${id} appears twice. Kept the first, on line ${calendars.get(id).line}.`)); continue; }
    const h = xerNum(rec.day_hr_cnt);
    calendars.set(id, { id, line, name: rec.clndr_name || id, dayHr: h > 0 ? h : null, isDefault: rec.default_flag === "Y" });
  }

  const projRow = parsed.tables.PROJECT?.rows[0];
  const proj = projRow?.rec || {};
  // The calendar used when an activity names none: the project's, else the one flagged default.
  const projCal = calendars.get(proj.clndr_id) || [...calendars.values()].find((c) => c.isDefault) || null;

  /** Hours per working day for a calendar id, and a short note on where the figure came from. */
  function hoursPerDay(clndrId) {
    const own = clndrId ? calendars.get(clndrId) : null;
    if (own?.dayHr) return { hpd: own.dayHr, basis: `calendar "${own.name}", ${own.dayHr} h a day` };
    if (!own && projCal?.dayHr) return { hpd: projCal.dayHr, basis: `project calendar "${projCal.name}", ${projCal.dayHr} h a day (the activity names no calendar)` };
    return { hpd: FALLBACK_HOURS_PER_DAY, basis: `${FALLBACK_HOURS_PER_DAY} h a day, the fallback (no day_hr_cnt for this calendar in the file)` };
  }

  const acts = new Map();
  for (const { line, rec } of parsed.tables.TASK?.rows || []) {
    const id = rec.task_id;
    const code = rec.task_code || id;
    if (!id) { breaks.push(brk(line, "TASK", "missing id", `Activity ${code || "(no code)"} has no task_id. Set aside.`)); continue; }
    if (acts.has(id)) { breaks.push(brk(line, "TASK", "duplicate id", `task_id ${id} (${code}) appears twice. Kept the first, on line ${acts.get(id).line}.`)); continue; }
    let type = rec.task_type;
    if (!TASK_TYPES.has(type)) { breaks.push(brk(line, "TASK", "unknown type", `Activity ${code} has task_type "${type}". Kept it, treated as a task.`, true)); type = "TT_Task"; }
    if (!STATUSES.has(rec.status_code)) breaks.push(brk(line, "TASK", "unknown status", `Activity ${code} has status_code "${rec.status_code}". Kept it, treated as not complete.`, true));
    if (rec.clndr_id && !calendars.has(rec.clndr_id)) breaks.push(brk(line, "TASK", "missing reference", `Activity ${code} uses calendar ${rec.clndr_id}, which is not in the CALENDAR table. Kept it.`, true));
    const tf = xerNum(rec.total_float_hr_cnt);
    const { hpd, basis } = hoursPerDay(rec.clndr_id);
    const tfHr = Number.isNaN(tf) ? null : tf;
    acts.set(id, {
      id, line, code, name: rec.task_name || "", type,
      complete: rec.status_code === "TK_Complete",
      tfHr, hpd, basis,
      tfDays: tfHr == null ? null : Math.round((tfHr / hpd) * 10) / 10,
      earlyEnd: rec.early_end_date && isXerDate(rec.early_end_date.trim()) ? rec.early_end_date.trim() : null,
      lateEnd: rec.late_end_date && isXerDate(rec.late_end_date.trim()) ? rec.late_end_date.trim() : null,
    });
  }

  const rels = [];
  const relIds = new Map();
  const pairs = new Map();
  for (const { line, rec } of parsed.tables.TASKPRED?.rows || []) {
    const rid = rec.task_pred_id;
    if (rid && relIds.has(rid)) { breaks.push(brk(line, "TASKPRED", "duplicate id", `task_pred_id ${rid} appears twice. Kept the first, on line ${relIds.get(rid)}.`)); continue; }
    if (rid) relIds.set(rid, line);
    const type = REL_TYPES[rec.pred_type];
    if (!type) { breaks.push(brk(line, "TASKPRED", "unknown link type", `Relationship type "${rec.pred_type}" is not FS, SS, FF or SF. Set aside.`)); continue; }
    const missing = [rec.pred_task_id, rec.task_id].filter((t) => !acts.has(t));
    if (missing.length) { breaks.push(brk(line, "TASKPRED", "missing reference", `Relationship points to task_id ${missing.join(" and ")}, not in the TASK table. Set aside.`)); continue; }
    if (rec.pred_task_id === rec.task_id) { breaks.push(brk(line, "TASKPRED", "self link", `Activity ${acts.get(rec.task_id).code} is linked to itself. Set aside.`)); continue; }
    const key = `${rec.pred_task_id}>${rec.task_id}>${type}`;
    if (pairs.has(key)) { breaks.push(brk(line, "TASKPRED", "duplicate link", `Same ${type} link as line ${pairs.get(key)}. Set aside.`)); continue; }
    pairs.set(key, line);
    rels.push({ line, pred: rec.pred_task_id, succ: rec.task_id, type });
  }

  breaks.sort((a, b) => a.line - b.line);
  return {
    header: parsed.header,
    project: { name: proj.proj_short_name || "", line: projRow?.line ?? null },
    rowCount: parsed.rowCount,
    calendars, activities: [...acts.values()], rels, breaks,
  };
}

/**
 * The three checks. Only incomplete activities that carry logic are judged:
 * level of effort (TT_LOE) and WBS summary (TT_WBS) activities are skipped, as are completed ones.
 */
export function runChecks(model, { highFloatDays = HIGH_FLOAT_DAYS } = {}) {
  const hasPred = new Set(model.rels.map((r) => r.succ));
  const hasSucc = new Set(model.rels.map((r) => r.pred));
  const judged = model.activities.filter((a) => !a.complete && a.type !== "TT_LOE" && a.type !== "TT_WBS");

  const openEnds = [];
  for (const a of judged) {
    // A start milestone may open the schedule and a finish milestone may close it. Nothing else may.
    const noPred = !hasPred.has(a.id) && a.type !== "TT_Mile";
    const noSucc = !hasSucc.has(a.id) && a.type !== "TT_FinMile";
    if (noPred || noSucc) openEnds.push({ ...a, missing: noPred && noSucc ? "no predecessor or successor" : noPred ? "no predecessor" : "no successor" });
  }
  const withFloat = judged.filter((a) => a.tfHr != null);
  const negative = withFloat.filter((a) => a.tfHr < 0).sort((a, b) => a.tfHr - b.tfHr);
  // Compare in hours against the threshold in that activity's own hours, so rounding to 0.1 day cannot move an activity across the line.
  const high = withFloat.filter((a) => a.tfHr > highFloatDays * a.hpd).sort((a, b) => b.tfHr - a.tfHr);

  const units = unitsCheck(judged);
  const bases = {};
  for (const a of judged) bases[a.basis] = (bases[a.basis] || 0) + 1;

  return {
    judged: judged.length,
    noFloat: judged.length - withFloat.length,
    highFloatDays,
    bases,
    units,
    openEnds, negative, high,
    histogram: floatHistogram(judged, highFloatDays),
  };
}

const DAY = 86400000;
const MONDAY = Date.UTC(2020, 0, 6);

/**
 * The working day (Monday to Friday) whose close a P6 date-time marks.
 * A finish at 08:00 or earlier, or on a weekend, is the close of the working day before.
 * Whole weekdays only: it knows nothing of shifts, holidays or partial days.
 */
export function closeOfDay(dt) {
  const days = Math.round((Date.parse(dt.slice(0, 10) + "T00:00:00Z") - MONDAY) / DAY);
  const weeks = Math.floor(days / 7);
  const dow = days - weeks * 7; // 0 = Monday
  const idx = weeks * 5 + Math.min(dow, 4);
  const early = (dt.slice(11, 16) || "17:00") <= "08:00";
  return dow >= 5 ? idx : early ? idx - 1 : idx;
}

/**
 * Weekday cross-check: a sample-specific sanity check under a Monday-to-Friday, 8-hour assumption.
 * It compares float in days with the whole weekdays between the row's own early finish and
 * late finish. It ignores shifts, holidays and partial days, and P6 can compute total float
 * from start float, finish float or the smaller of the two, so this compares finishes only.
 * Agreement is a sanity check on the two sample files, not proof that units, calendars or
 * float are right in general.
 */
export function unitsCheck(acts) {
  let agree = 0, compared = 0;
  const disagree = [];
  for (const a of acts) {
    if (a.tfHr == null || !a.earlyEnd || !a.lateEnd) continue;
    compared++;
    const days = closeOfDay(a.lateEnd) - closeOfDay(a.earlyEnd);
    if (Math.abs(days - a.tfHr / a.hpd) < 0.05) agree++;
    else disagree.push({ ...a, datesSay: days });
  }
  return { compared, agree, disagree };
}

/** Float in working days, in bins that line up with the two float checks. */
export function floatHistogram(acts, highFloatDays = HIGH_FLOAT_DAYS) {
  const bins = [
    { key: "neg", label: "Below 0", n: 0 },
    { key: "zero", label: "Exactly 0", n: 0 },
    { key: "low", label: "Over 0, up to 10", n: 0 },
    { key: "mid", label: `Over 10, up to ${highFloatDays}`, n: 0 },
    { key: "high", label: `Over ${highFloatDays}`, n: 0 },
    { key: "none", label: "No float value", n: 0 },
  ];
  const at = Object.fromEntries(bins.map((b) => [b.key, b]));
  for (const a of acts) {
    if (a.tfHr == null) at.none.n++;
    else if (a.tfHr < 0) at.neg.n++;
    else if (a.tfHr === 0) at.zero.n++;
    else if (a.tfHr <= 10 * a.hpd) at.low.n++;
    else if (a.tfHr <= highFloatDays * a.hpd) at.mid.n++;
    else at.high.n++;
  }
  return bins;
}

/** Text in, full result out. Used by the page, the CLI and the tests. */
export function checkXer(text, opts) {
  const model = buildModel(parseXer(text));
  return { model, checks: runChecks(model, opts) };
}
