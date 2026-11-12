import { decodeXer } from "./xer.js";
import { checkXer, HIGH_FLOAT_DAYS } from "./checks.js";

const SAMPLES = [
  { file: "aspose-testXer.xer", label: "Aspose test file" },
  { file: "hb-intel-Project_Schedule.xer", label: "hb-intel schedule" },
];
const SHOW = 12;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const glyph = (k) => `<svg aria-hidden="true"><use href="#i-${k}"/></svg>`;
const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const fmtDays = (d) => `${d.toLocaleString("en-GB", { maximumFractionDigits: 1 })} d`;

let current = null;

function fileButtons(active) {
  $("files").innerHTML = SAMPLES.map((s, i) =>
    `<button type="button" class="seg" data-i="${i}" aria-pressed="${active === i}">${esc(s.label)}<span>${esc(s.file)}</span></button>`).join("");
}
$("files").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (b) loadSample(Number(b.dataset.i), true);
});

async function loadSample(i, fresh) {
  fileButtons(i);
  const s = SAMPLES[i];
  try {
    const res = await fetch(`samples/${s.file}`);
    if (!res.ok) throw new Error(res.status);
    show(s.file, decodeXer(await res.arrayBuffer()), fresh);
  } catch {
    $("summary").innerHTML = `<span class="sum-main small">Could not load the sample</span>`;
    $("chain").textContent = "Serve this folder (node serve.js) rather than opening the file directly, or choose a file below.";
  }
}

$("own").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $("error").hidden = true;
  try {
    fileButtons(-1);
    show(f.name, decodeXer(await f.arrayBuffer()), true);
    $("summary").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } catch (err) {
    $("error").textContent = `Could not read ${f.name}: ${err.message}`;
    $("error").hidden = false;
  }
});

function show(name, { text }, fresh) {
  const { model, checks } = checkXer(text, { highFloatDays: HIGH_FLOAT_DAYS });
  current = { name, model, checks };
  const flagged = new Set([...checks.openEnds, ...checks.negative, ...checks.high].map((a) => a.id));
  const setAside = model.breaks.filter((b) => !b.kept).length;

  $("docline").textContent = `Project ${model.project.name || "with no name"}: ${plural(model.activities.length, "activity", "activities")}, ${plural(model.rels.length, "link")}, ${plural(model.rowCount, "row")}.`;
  $("summary").innerHTML =
    `<span class="sum-main">${plural(flagged.size, "activity", "activities")} flagged</span>` +
    `<span class="sum-side ${model.breaks.length ? (setAside ? "fail" : "") : "muted"}">${plural(model.breaks.length, "broken row")}</span>`;
  $("chain").textContent = `${plural(checks.openEnds.length, "open end")}, ${checks.negative.length} with negative float, ${checks.high.length} over ${HIGH_FLOAT_DAYS} days of float.`;

  renderRows(model, checks, fresh);
  renderChart(checks);

  const bases = Object.entries(checks.bases).map(([b, n]) => `${b}, for ${plural(n, "activity", "activities")}`).join("; ");
  $("how").innerHTML =
    `Float in days is the file's total_float_hr_cnt divided by hours a day. Hours a day: ${esc(bases)}. ` +
    `Cross-check: for ${checks.units.agree} of ${checks.units.compared} activities, that matches the working days between the row's own early and late finish.`;
}

/* The four rows: broken rows first, then the three checks */
function renderRows(model, checks, fresh) {
  const kept = model.breaks.filter((b) => b.kept).length;
  const aside = model.breaks.length - kept;
  const rows = [
    {
      key: "breaks", term: "Broken rows",
      status: model.breaks.length ? (aside ? ["fail", "cross", "Set aside"] : ["none", "none", "Found"]) : ["pass", "check", "None"],
      value: model.breaks.length ? `${plural(model.breaks.length, "row")}${aside ? `, ${aside} set aside` : ", all kept, bad values ignored"}` : "Every row has the right fields and readable values",
      rule: "Checked: field count against the table's %F line, duplicate task and link ids, links to tasks not in the file, unknown link types, and every date and number field in PROJECT, CALENDAR, TASK and TASKPRED.",
      body: () => breakList(model.breaks),
    },
    {
      key: "links", term: "Missing links",
      status: checks.openEnds.length ? ["fail", "cross", "Flag"] : ["pass", "check", "Clear"],
      value: checks.openEnds.length ? `${plural(checks.openEnds.length, "open end")} of ${checks.judged}` : "Every activity has both ends tied",
      rule: "Rule: an activity that is not complete needs a predecessor and a successor. A start milestone may have no predecessor and a finish milestone no successor. Level of effort and WBS summary activities are skipped.",
      body: () => actList(checks.openEnds, (a) => a.missing),
    },
    {
      key: "neg", term: "Negative float",
      status: checks.negative.length ? ["fail", "cross", "Flag"] : ["pass", "check", "Clear"],
      value: checks.negative.length ? `${plural(checks.negative.length, "activity", "activities")} below 0` : "No activity below 0 days",
      rule: "Rule: total float below 0, read from total_float_hr_cnt. Negative float means a date cannot be met as the logic stands.",
      body: () => actList(checks.negative, (a) => fmtDays(a.tfDays), true),
    },
    {
      key: "high", term: "High float",
      status: checks.high.length ? ["fail", "cross", "Flag"] : ["pass", "check", "Clear"],
      value: checks.high.length ? `${plural(checks.high.length, "activity", "activities")} over ${HIGH_FLOAT_DAYS} days` : `None over ${HIGH_FLOAT_DAYS} days`,
      rule: `Rule: total float above ${HIGH_FLOAT_DAYS} working days, the line the DCMA 14-point assessment uses. That much float usually means a missing link, not real slack.`,
      body: () => actList(checks.high, (a) => fmtDays(a.tfDays), true),
    },
  ];
  const box = $("rows");
  box.className = "rows" + (fresh ? " fresh" : "");
  box.innerHTML = rows.map((r) => `
    <div class="row-item">
      <button type="button" class="row verdict" aria-expanded="false" aria-controls="ev-${r.key}" data-key="${r.key}">
        <span class="status st-${r.status[0]}">${glyph(r.status[1])}${r.status[2]}</span>
        <span class="val"><b>${r.term}</b>${esc(r.value)}</span>
        <svg class="chev" aria-hidden="true"><use href="#i-chev"/></svg>
      </button>
      <div class="evidence" id="ev-${r.key}" hidden></div>
    </div>`).join("");
  box.querySelectorAll(".row").forEach((btn, i) => btn.addEventListener("click", () => {
    const ev = btn.nextElementSibling;
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      ev.innerHTML = `<p class="rule">${esc(rows[i].rule)}</p>${rows[i].body()}`;
      ev.hidden = false;
      ev.classList.remove("enter", "drawn");
      void ev.offsetWidth;
      ev.classList.add("enter");
      requestAnimationFrame(() => ev.classList.add("drawn"));
      wireMore(ev);
    } else ev.hidden = true;
  }));
}

function actList(acts, detail, underline = false) {
  if (!acts.length) return `<p class="nf-note">Nothing to list.</p>`;
  const li = (a, i) => `<li${i >= SHOW ? " hidden" : ""}>
      <span class="act"><span class="code">${esc(a.code)}</span> <q>${esc(a.name)}</q></span>
      <span class="f"><span class="${underline ? "u fail" : ""}">${esc(detail(a))}</span><span class="ln">line ${a.line}</span></span>
    </li>`;
  return `<ul class="acts">${acts.map(li).join("")}</ul>${more(acts.length)}`;
}

function breakList(breaks) {
  if (!breaks.length) return `<p class="nf-note">No broken rows in this file.</p>`;
  // Rows with the same reason are listed once, with all their line numbers.
  const groups = new Map();
  for (const b of breaks) {
    const k = `${b.table}|${b.kind}|${b.reason}`;
    if (!groups.has(k)) groups.set(k, { ...b, lines: [] });
    groups.get(k).lines.push(b.line);
  }
  const g = [...groups.values()];
  const li = (b, i) => `<li${i >= SHOW ? " hidden" : ""}>
      <span class="act"><span class="code">${esc(b.table || "File")}, ${esc(b.kind)}</span> ${esc(b.reason)}</span>
      <span class="f"><span class="ln">${lineRange(b.lines)}</span></span>
    </li>`;
  return `<ul class="acts breaks">${g.map(li).join("")}</ul>${more(g.length)}`;
}

function lineRange(lines) {
  if (lines.length === 1) return `line ${lines[0]}`;
  const run = lines.every((l, i) => i === 0 || l === lines[i - 1] + 1);
  return run ? `lines ${lines[0]} to ${lines.at(-1)}` : `lines ${lines.join(", ")}`;
}

const more = (n) => (n > SHOW ? `<button type="button" class="btn text more">Show all ${n}</button>` : "");
function wireMore(ev) {
  const b = ev.querySelector(".more");
  if (b) b.addEventListener("click", () => { ev.querySelectorAll("li[hidden]").forEach((li) => (li.hidden = false)); b.remove(); });
}

/* The chart: float in working days, binned to line up with the two float checks */
function renderChart(checks) {
  const bins = checks.histogram;
  const max = Math.max(1, ...bins.map((b) => b.n));
  const rows = bins.map((b) => `<li class="bin ${b.key}">
      <span class="lbl">${esc(b.label)}</span>
      <span class="track"><span class="bar" style="--w:${b.n ? Math.max(1.5, (b.n / max) * 100) : 0}%"></span><span class="num">${b.n}</span></span>
    </li>`).join("");
  const el = $("chart");
  el.innerHTML = `<p class="chart-h">Total float, in working days</p>
    <ul class="bins" role="img" aria-label="${esc(bins.map((b) => `${b.label}: ${b.n}`).join(", "))}">${rows}</ul>
    <figcaption>${checks.judged} activities that are not complete. Red is below 0, amber is over ${checks.highFloatDays} days: the two float checks.</figcaption>`;
  el.hidden = false;
}

loadSample(0, false);
