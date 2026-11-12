#!/usr/bin/env node
// node check.js file.xer [more.xer] [--high 44] [--json]
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { decodeXer } from "./xer.js";
import { checkXer, HIGH_FLOAT_DAYS } from "./checks.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const hi = args.indexOf("--high");
const highFloatDays = hi >= 0 ? Number(args[hi + 1]) : HIGH_FLOAT_DAYS;
const files = args.filter((a, i) => !a.startsWith("--") && !(hi >= 0 && i === hi + 1));
if (!files.length || !(highFloatDays >= 0)) {
  console.error("Usage: node check.js file.xer [more.xer] [--high 44] [--json]");
  process.exit(2);
}

const days = (d) => `${d} d`;
const out = [];
for (const f of files) {
  const { text, encoding } = decodeXer(readFileSync(f));
  const { model, checks } = checkXer(text, { highFloatDays });
  if (json) {
    out.push({ file: basename(f), encoding, project: model.project.name, activities: model.activities.length, links: model.rels.length, breaks: model.breaks, ...checks });
    continue;
  }
  const p = (s = "") => console.log(s);
  p(`${basename(f)}  ${model.project.name}  ${model.activities.length} activities, ${model.rels.length} links, ${model.rowCount} rows, ${encoding}`);
  p(`  Units: ${Object.entries(checks.bases).map(([b, n]) => `${n} on ${b}`).join("; ")}`);
  p(`  Units cross-check: float matches late minus early finish for ${checks.units.agree} of ${checks.units.compared}`);
  p(`  Broken rows: ${model.breaks.length}`);
  for (const b of model.breaks) p(`    line ${b.line}  ${b.table}  ${b.kind}: ${b.reason}`);
  p(`  Missing links: ${checks.openEnds.length} of ${checks.judged} judged activities`);
  for (const a of checks.openEnds) p(`    line ${a.line}  ${a.code}  ${a.name}: ${a.missing}`);
  p(`  Negative float: ${checks.negative.length}`);
  for (const a of checks.negative) p(`    line ${a.line}  ${a.code}  ${a.name}: ${days(a.tfDays)}`);
  p(`  High float (over ${highFloatDays} working days): ${checks.high.length}`);
  for (const a of checks.high) p(`    line ${a.line}  ${a.code}  ${a.name}: ${days(a.tfDays)}`);
  p(`  Float in working days: ${checks.histogram.map((b) => `${b.label} ${b.n}`).join(", ")}`);
  p();
}
if (json) console.log(JSON.stringify(out, null, 2));
