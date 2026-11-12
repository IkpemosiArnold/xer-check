// A small Primavera P6 XER reader. Plain functions, no DOM.
// Adapted from the reader in Arnold's update-review demo (MIT).
//
// XER is tab-separated text: ERMHDR is the header, %T starts a table, %F names
// its fields, %R is a row, %E ends the file. Nothing is skipped quietly: a row
// that cannot be read is set aside with its line number and a plain reason.

/** Decode bytes: UTF-8 if it is valid, otherwise Windows-1252, which P6 exports often use. */
export function decodeXer(bytes) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

/**
 * Split an XER file into tables.
 * @returns {{tables: Record<string, {name:string, fields: string[], line:number, rows: {line:number, rec: Record<string,string>}[]}>,
 *            breaks: {line:number, table:string, kind:string, reason:string, kept:boolean}[], header: string[], rowCount:number}}
 */
export function parseXer(text) {
  const tables = {};
  const breaks = [];
  let header = [];
  let cur = null;
  let rowCount = 0;
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const cells = raw.split("\t");
    const tag = cells[0];
    if (tag === "ERMHDR") header = cells.slice(1);
    else if (tag === "%T") {
      const name = (cells[1] || "").trim();
      cur = tables[name] = tables[name] || { name, fields: [], rows: [], line };
    } else if (tag === "%F") {
      if (!cur) breaks.push(brk(line, "", "structure", "Field names before any table."));
      else cur.fields = cells.slice(1).map((f) => f.trim());
    } else if (tag === "%R") {
      rowCount++;
      if (!cur || !cur.fields.length) {
        breaks.push(brk(line, cur ? cur.name : "", "structure", "A row before its field names."));
        return;
      }
      const vals = cells.slice(1);
      if (vals.length !== cur.fields.length) {
        breaks.push(brk(line, cur.name, "field count", `Row has ${vals.length} fields; the ${cur.name} table has ${cur.fields.length}.`));
        return;
      }
      const rec = {};
      cur.fields.forEach((f, k) => { if (f) rec[f] = vals[k]; });
      cur.rows.push({ line, rec });
    } else if (tag === "%E") cur = null;
    else breaks.push(brk(line, cur ? cur.name : "", "structure", `Unknown line type "${tag.slice(0, 12)}".`));
  });
  return { tables, breaks, header, rowCount };
}

/** A broken-row record. kept=false means the row was set aside; true means it was kept with the bad value ignored. */
export function brk(line, table, kind, reason, kept = false) {
  return { line, table, kind, reason, kept };
}
