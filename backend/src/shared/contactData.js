// Contact data helpers shared by the API (backend/src) and the web app (src/lib).
// Plain JavaScript with no dependencies so both sides can import the same file.
// Types: contactData.d.ts.

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export const isValidEmail = (s) => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);

/** Trim, lowercase and strip wrappers people paste around addresses ("<a@b.com>", "mailto:a@b.com,"). */
export function normalizeEmail(value) {
  return String(value ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^[<("'\s]+|[>)"'\s.,;:]+$/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Company name from email domain
// ---------------------------------------------------------------------------

// Multi-part public suffixes that must be removed as a whole (infosys.co.in → infosys).
const MULTI_PART_SUFFIXES = [
  "co.in", "ac.in", "org.in", "net.in", "gov.in", "edu.in", "res.in", "firm.in", "gen.in", "ind.in", "nic.in",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "co.nz", "co.jp", "co.za", "co.kr",
  "com.sg", "com.my", "com.br", "com.cn", "com.hk", "com.mx", "com.tr", "com.pk", "com.bd", "com.np", "com.lk",
];

// Hostname labels that describe a department or mail system, not the company.
const IGNORED_SUBDOMAINS = new Set([
  "www", "mail", "email", "e-mail", "smtp", "mx", "m", "web", "careers", "career", "jobs", "job", "hr",
  "recruitment", "recruit", "recruiting", "recruiter", "recruiters", "talent", "hiring", "apply", "people",
]);

// Personal mailbox providers: the domain says nothing about where the person works.
const FREE_EMAIL_PROVIDERS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "rocketmail", "outlook", "hotmail", "live", "msn", "icloud", "me",
  "mac", "aol", "proton", "protonmail", "pm", "zohomail", "rediffmail", "rediff", "yandex", "gmx", "mail",
  "inbox", "fastmail", "tutanota", "hey",
]);

function readableCompany(label) {
  if (/^[a-z0-9]{1,3}$/.test(label)) return label.toUpperCase(); // tcs → TCS, ey → EY, 3m → 3M
  return label
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * "recruiter@infosys.co.in" → "Infosys", "jobs@careers.company.com" → "Company", "hr@tcs.com" → "TCS".
 * Returns "" for invalid addresses and free mail providers (gmail.com etc.).
 */
export function companyFromEmail(email) {
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) return "";
  let domain = e.slice(e.lastIndexOf("@") + 1);

  const multi = MULTI_PART_SUFFIXES.find((s) => domain.endsWith(`.${s}`));
  if (multi) domain = domain.slice(0, -(multi.length + 1));
  else domain = domain.slice(0, domain.lastIndexOf("."));

  const labels = domain.split(".").filter(Boolean);
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i];
    if (IGNORED_SUBDOMAINS.has(label)) continue;
    if (FREE_EMAIL_PROVIDERS.has(label)) return "";
    return readableCompany(label);
  }
  return "";
}

/** Use the entered company when there is one, otherwise derive it from the email. */
export function resolveCompany(company, email) {
  const entered = String(company ?? "").trim();
  return entered || companyFromEmail(email);
}

// ---------------------------------------------------------------------------
// Spelling suggestions (suggest only, never auto-correct)
// ---------------------------------------------------------------------------

const WORDS = [
  "career", "careers", "company", "companies", "corporate", "corporation", "recruitment", "recruit", "recruits",
  "recruiter", "recruiters", "recruiting", "human", "resources", "jobs", "india", "talent", "hiring",
  "technologies", "technology", "solutions", "services", "software", "systems", "consulting", "limited",
  "private", "international", "global", "groups", "group", "enterprises", "industries",
];
const DICTIONARY = new Set(WORDS);
// Real words / names that sit one keystroke away from a dictionary word.
const ALLOWED = new Set(["carer", "carter", "indian", "indie", "indiana", "globe", "globally", "privates"]);

const COMMON_TLDS = ["com", "in", "org", "net", "edu", "io", "co"];
const KNOWN_TLDS = new Set([
  ...COMMON_TLDS, "ai", "app", "dev", "gov", "mil", "int", "biz", "info", "me", "tech", "us", "uk", "ca", "au",
  "de", "fr", "jp", "cn", "sg", "ae", "nz", "eu", "xyz", "online", "site", "store", "cloud", "ac", "ly", "tv",
  "so", "to", "gg", "pro", "inc", "llc", "ltd", "global", "agency", "digital", "solutions", "software",
  "art", "bio", "cat", "eco", "eus", "ink", "new", "ngo", "now", "one", "top", "win", "law", "med", "run",
  "fit", "fun", "gay", "bar", "car", "cab", "aero", "asia", "coop", "jobs", "mobi", "name", "work", "zone",
  "team", "news", "shop", "life", "live", "blog", "club", "design", "email", "page", "wiki",
]);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const NEIGHBOURS = (() => {
  const map = {};
  KEYBOARD_ROWS.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const near = new Set();
      for (const dr of [-1, 0, 1]) {
        const other = KEYBOARD_ROWS[r + dr];
        if (!other) continue;
        for (const dc of [-1, 0, 1]) {
          const n = other[c + dc];
          if (n && n !== ch) near.add(n);
        }
      }
      map[ch] = near;
    });
  });
  return map;
})();
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

// A substitution only counts as a likely typo for vowel↔vowel or neighbouring keys.
// Anything else costs 2, which keeps real words like "carter" from matching "career".
const substitutionCost = (a, b) =>
  a === b ? 0 : (VOWELS.has(a) && VOWELS.has(b)) || NEIGHBOURS[a]?.has(b) ? 1 : 2;

/** Optimal-string-alignment distance with typo-weighted substitutions. */
function typoDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + substitutionCost(a[i - 1], b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function closestWord(token, candidates, maxDistance) {
  let best = null;
  for (const word of candidates) {
    if (word[0] !== token[0] || Math.abs(word.length - token.length) > maxDistance) continue;
    const dist = typoDistance(token, word);
    if (dist === 0 || dist > maxDistance) continue;
    const score = dist * 10 + Math.abs(word.length - token.length);
    if (!best || score < best.score) best = { word, score };
  }
  return best?.word ?? null;
}

function matchCase(source, word) {
  if (source === source.toUpperCase()) return word.toUpperCase();
  if (source[0] === source[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/**
 * Suggest corrections for common recruitment / company words in a value.
 * kind: "email" | "company" | "name". Returns [] when nothing looks wrong.
 * Each suggestion carries the whole corrected value so the UI can offer Apply / Ignore.
 */
export function findSpellingSuggestions(value, kind = "company") {
  const text = String(value ?? "");
  if (!text.trim()) return [];
  const minLength = kind === "name" ? 6 : 4;
  const suggestions = [];

  const tldStart = kind === "email" && text.includes("@") ? text.lastIndexOf(".") + 1 : -1;

  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    const token = m[0];
    const lower = token.toLowerCase();
    const start = m.index;
    let replacement = null;

    if (start === tldStart && start > 0) {
      // Two-letter endings are left alone: almost all of them are real country codes (.ie, .ni).
      if (!KNOWN_TLDS.has(lower) && lower.length >= 3 && lower.length <= 4) {
        replacement = closestWord(lower, COMMON_TLDS, 1) ?? COMMON_TLDS.find((t) => typoDistance(lower, t) === 1) ?? null;
      }
    } else {
      // Skip short tokens, known words, allow-listed real words and abbreviations (TCS, HCL).
      if (lower.length < minLength || DICTIONARY.has(lower) || ALLOWED.has(lower)) continue;
      if (kind !== "email" && token === token.toUpperCase()) continue;
      replacement = closestWord(lower, WORDS, lower.length >= 8 ? 2 : 1);
      if (replacement) replacement = matchCase(token, replacement);
    }

    if (replacement && replacement.toLowerCase() !== lower) {
      suggestions.push({
        from: token,
        to: replacement,
        original: text,
        suggestion: text.slice(0, start) + replacement + text.slice(start + token.length),
      });
    }
  }

  return suggestions;
}

/** Apply every suggestion found in a value (used when the user accepts all of them). */
export function applyAllSuggestions(value, kind) {
  let out = String(value ?? "");
  for (let guard = 0; guard < 10; guard++) {
    const [first] = findSpellingSuggestions(out, kind);
    if (!first) break;
    out = first.suggestion;
  }
  return out;
}

/** Suggestions for the fields of a contact that are worth checking. */
export function contactSpellingSuggestions(contact) {
  const out = [];
  for (const [field, kind] of [["email", "email"], ["company", "company"], ["title", "company"], ["name", "name"]]) {
    for (const s of findSpellingSuggestions(contact?.[field], kind)) out.push({ field, ...s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

const FIELD_ALIASES = {
  name: ["name", "full name", "fullname", "contact name", "contact", "person"],
  email: ["email", "email id", "emailid", "email address", "e-mail", "e mail", "mail", "mail id"],
  title: ["title", "job title", "role", "designation", "position"],
  company: ["company", "company name", "organization", "organisation", "org", "employer"],
  category: ["category", "group", "tag", "list"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
};
const LIMITS = { name: 150, email: 254, title: 150, company: 150, category: 80, notes: 5000 };

const headerKey = (k) => String(k ?? "").toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ").trim();

/** Which contact field a column header refers to, or null. */
export function fieldForHeader(header) {
  const h = headerKey(header).replace(/\s*\(.*\)$/, "");
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) if (aliases.includes(h)) return field;
  return null;
}

/** Map a spreadsheet-style record ({ "Email ID": ..., "Full Name": ... }) onto contact fields. */
export function normalizeImportRow(raw) {
  const out = { name: "", email: "", title: "", company: "", category: "", notes: "" };
  for (const [key, value] of Object.entries(raw ?? {})) {
    const field = fieldForHeader(key);
    const v = String(value ?? "").trim();
    if (field && v && !out[field]) out[field] = v.slice(0, LIMITS[field]);
  }
  out.email = normalizeEmail(out.email);
  return out;
}

const LABEL_WORDS = new Set([
  "email", "e-mail", "mail", "contact", "phone", "mobile", "tel", "hr", "team", "careers", "jobs", "info",
  "support", "sales", "admin", "hello", "office", "linkedin", "website", "name", "title", "company",
]);

function looksLikeName(s) {
  const words = s.trim().split(/\s+/);
  if (!s.trim() || s.length > 60 || words.length > 4) return false;
  if (words.some((w) => LABEL_WORDS.has(w.toLowerCase().replace(/[:.]$/, "")))) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w)) && /[A-Z]/.test(s);
}

const KEY_VALUE_RE = /^\s*([A-Za-z][A-Za-z _-]{0,20}?)\s*[:=]\s*(.+?)\s*$/;

/** "Name: …" / "Email: …" blocks, one contact per block. */
function extractKeyValueBlocks(lines) {
  const records = [];
  let current = null;
  const flush = () => {
    if (current?.email) records.push(current);
    current = null;
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const m = line.match(KEY_VALUE_RE);
    const field = m && fieldForHeader(m[1]);
    if (!field) continue;
    if (current?.[field] && (field === "email" || field === "name")) flush();
    current ??= { name: "", email: "", title: "", company: "", category: "", notes: "", source: "" };
    const value = field === "email" ? normalizeEmail(m[2].match(EMAIL_IN_TEXT_RE)?.[0] ?? m[2]) : m[2].slice(0, LIMITS[field]);
    current[field] = value;
    current.source = current.source ? `${current.source} · ${line.trim()}` : line.trim();
  }
  flush();
  return records;
}

/** Free-form lines: pull out emails and, when it's unambiguous, the person's name / title / company. */
function extractFromLine(line) {
  const emails = [...line.matchAll(EMAIL_IN_TEXT_RE)].map((m) => m[0]);
  if (emails.length === 0) return [];
  const base = { name: "", title: "", company: "", category: "", notes: "", source: line.trim().slice(0, 300) };
  if (emails.length > 1) return emails.map((e) => ({ ...base, email: normalizeEmail(e) }));

  const email = normalizeEmail(emails[0]);
  const row = { ...base, email };
  const rest = line
    .replace(emails[0], " ")
    .replace(/mailto:/gi, " ")
    .replace(/\b(e-?mail|email id)\s*[:=-]?/gi, " ")
    .replace(/[<>()[\]"]/g, " ");
  const parts = rest
    .split(/\s*[,|;\t]\s*|\s+[-–—]\s+/)
    // "Also: Ravi Kumar" → "Ravi Kumar": text before a colon is a label, not contact data.
    .map((p) => p.slice(p.lastIndexOf(":") + 1))
    .map((p) => p.replace(/^[\s:.\-–—]+|[\s:.\-–—]+$/g, ""))
    .filter(Boolean);

  for (const part of parts) {
    const at = part.match(/^(.{2,80}?)\s+(?:at|@)\s+(.{2,80})$/i);
    if (at && !row.title && !row.company) {
      row.title = at[1].trim();
      row.company = at[2].trim();
    } else if (!row.name && looksLikeName(part)) {
      row.name = part.trim();
    }
  }
  return [row];
}

/**
 * Extract contacts from plain text (TXT files, Word documents).
 * `structured` is false when contacts were picked out of free text and deserve a manual review.
 */
export function extractContactsFromText(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = extractKeyValueBlocks(lines);
  const blockEmails = new Set(blocks.map((b) => b.email));

  const free = [];
  for (const line of lines) {
    if (KEY_VALUE_RE.test(line) && fieldForHeader(line.match(KEY_VALUE_RE)[1])) continue;
    for (const row of extractFromLine(line)) if (!blockEmails.has(row.email)) free.push(row);
  }
  return { rows: [...blocks, ...free], structured: free.length === 0 && blocks.length > 0 };
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decodeEntities = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const stripTags = (s) => decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")).trim();

/** Split simple document HTML (as produced by mammoth for .docx) into tables and remaining text. */
export function htmlToBlocks(html) {
  const tables = [];
  const withoutTables = String(html ?? "").replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) =>
      [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((td) => stripTags(td[1]).replace(/\s*\n\s*/g, " ")),
    );
    tables.push(rows.filter((r) => r.some(Boolean)));
    return "\n";
  });
  const text = withoutTables.replace(/<\/(p|h\d|li)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return { tables, text: decodeEntities(text) };
}

/** Turn a table whose first row is a header with an email column into records; null otherwise. */
export function rowsFromTable(table) {
  if (!table?.length) return null;
  const header = table[0];
  if (!header.some((h) => fieldForHeader(h) === "email")) return null;
  return table.slice(1).map((cells) => {
    const raw = {};
    header.forEach((h, i) => (raw[h] = cells[i] ?? ""));
    return { ...normalizeImportRow(raw), source: "" };
  });
}
