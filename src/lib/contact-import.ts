// Reads contact files in the browser (CSV, Excel, Word, plain text) into rows for the import preview.
// Relative imports only, so the parsers can also be exercised from Node scripts.
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  extractContactsFromText,
  fieldForHeader,
  htmlToBlocks,
  normalizeImportRow,
  rowsFromTable,
  type ImportRow,
} from "./contact-data.ts";

export type ImportFormat = "csv" | "excel" | "docx" | "txt";

export interface ParsedImport {
  format: ImportFormat;
  rows: ImportRow[];
  /** False when contacts were picked out of free text and should be reviewed before importing. */
  structured: boolean;
}

export const ACCEPTED_IMPORT_TYPES = ".csv,.xlsx,.xls,.docx,.txt";

export function importFormatFor(fileName: string): ImportFormat | null {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "excel";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  return null;
}

const decodeText = (buffer: ArrayBuffer) => {
  const text = new TextDecoder("utf-8").decode(buffer);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a byte-order mark
};

const hasEmailColumn = (headers: string[]) => headers.some((h) => fieldForHeader(h) === "email");

/** Delimited text with a header row that names an email column (CSV, TSV, "a | b" lists). */
function parseDelimited(text: string): ImportRow[] | null {
  const res = Papa.parse<Record<string, unknown>>(text.trim(), { header: true, skipEmptyLines: "greedy" });
  if (!hasEmailColumn(res.meta.fields ?? [])) return null;
  return res.data.map((r) => normalizeImportRow(r));
}

async function parseDocx(buffer: ArrayBuffer): Promise<ParsedImport> {
  // Loaded on demand: only people importing Word files download the parser.
  const mammoth = await import("mammoth");
  // Browser build reads `arrayBuffer`, the Node build reads `buffer`.
  const input = { arrayBuffer: buffer, buffer } as unknown as { arrayBuffer: ArrayBuffer };
  const { value: html } = await mammoth.convertToHtml(input);
  const { tables, text } = htmlToBlocks(html);

  const rows: ImportRow[] = [];
  const looseLines: string[] = [];
  for (const table of tables) {
    const tableRows = rowsFromTable(table);
    if (tableRows) rows.push(...tableRows);
    else looseLines.push(...table.map((cells) => cells.join(" | ")));
  }
  const fromText = extractContactsFromText([text, ...looseLines].join("\n"));
  const seen = new Set(rows.map((r) => r.email));
  const extra = fromText.rows.filter((r) => !seen.has(r.email));
  rows.push(...extra);

  // Structured when everything came from a header table or "Name: / Email:" blocks.
  return { format: "docx", rows, structured: extra.length === 0 || fromText.structured };
}

export async function parseContactBuffer(fileName: string, buffer: ArrayBuffer): Promise<ParsedImport> {
  const format = importFormatFor(fileName);
  if (!format) throw new Error("Unsupported file. Upload a CSV, Excel (.xlsx/.xls), Word (.docx) or text (.txt) file.");

  if (format === "docx") return parseDocx(buffer);

  if (format === "excel") {
    const wb = XLSX.read(buffer, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { format, rows: [], structured: true };
    const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    if (records.length && hasEmailColumn(Object.keys(records[0]))) {
      return { format, rows: records.map((r) => normalizeImportRow(r)), structured: true };
    }
    // No header row with an email column: fall back to scanning the cells for addresses.
    return { format, ...extractContactsFromText(XLSX.utils.sheet_to_csv(sheet, { FS: " | " })) };
  }

  const text = decodeText(buffer);
  const delimited = parseDelimited(text);
  if (delimited) return { format, rows: delimited, structured: true };
  return { format, ...extractContactsFromText(text) };
}

export async function parseContactFile(file: File): Promise<ParsedImport> {
  return parseContactBuffer(file.name, await file.arrayBuffer());
}

export const TEMPLATE_HEADERS = ["Name", "Email", "Title", "Company", "Category", "Notes"] as const;

/** Workbook for "Download Excel Template": headers plus two example rows to overwrite. */
export function buildContactTemplate(): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...TEMPLATE_HEADERS],
    ["Priya Sharma", "priya.sharma@example.com", "HR Manager", "Example Corp", "Hiring", "Met at a job fair"],
    ["", "careers@example.co.in", "", "", "Hiring", "Only Email is required. Company is filled from the email if left empty."],
  ]);
  sheet["!cols"] = [{ wch: 22 }, { wch: 32 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 60 }];
  sheet["!autofilter"] = { ref: "A1:F1" };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Contacts");
  return wb;
}

export function downloadContactTemplate() {
  XLSX.writeFile(buildContactTemplate(), "MailFlow_Contacts_Template.xlsx");
}
