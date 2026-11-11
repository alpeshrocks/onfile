/**
 * Small RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF, and a BOM.
 * Bulk import is how a firm puts its backlog of open files through signing on day one.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== "")).map((r) => r.map((c) => c.trim()));
}

export interface CsvRecords {
  headers: string[];
  records: Record<string, string>[];
}

/** First row becomes header keys, normalized to snake_case so "Client Name" matches client_name. */
export function csvToRecords(input: string): CsvRecords {
  const rows = parseCsv(input);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) =>
    h
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""),
  );
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) rec[h] = r[i] ?? "";
    });
    return rec;
  });
  return { headers: headers.filter(Boolean), records };
}
