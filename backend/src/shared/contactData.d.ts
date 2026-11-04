export const EMAIL_RE: RegExp;
export function isValidEmail(s: unknown): boolean;
export function normalizeEmail(value: unknown): string;

export function companyFromEmail(email: unknown): string;
export function resolveCompany(company: unknown, email: unknown): string;

export type SpellingKind = "email" | "company" | "name";
export interface SpellingSuggestion {
  /** The misspelled word as entered. */
  from: string;
  /** The suggested word. */
  to: string;
  /** The full original value. */
  original: string;
  /** The full value with this one word corrected. */
  suggestion: string;
}
export function findSpellingSuggestions(value: unknown, kind?: SpellingKind): SpellingSuggestion[];
export function applyAllSuggestions(value: unknown, kind: SpellingKind): string;
export function contactSpellingSuggestions(contact: {
  email?: string;
  company?: string;
  title?: string;
  name?: string;
}): (SpellingSuggestion & { field: "email" | "company" | "title" | "name" })[];

export type ContactField = "name" | "email" | "title" | "company" | "category" | "notes";
export interface ImportRow {
  name: string;
  email: string;
  title: string;
  company: string;
  category: string;
  notes: string;
  /** Original text the row was extracted from (free-text imports). */
  source?: string;
}
export function fieldForHeader(header: unknown): ContactField | null;
export function normalizeImportRow(raw: Record<string, unknown>): ImportRow;
export function extractContactsFromText(text: string): { rows: ImportRow[]; structured: boolean };
export function htmlToBlocks(html: string): { tables: string[][][]; text: string };
export function rowsFromTable(table: string[][]): ImportRow[] | null;
