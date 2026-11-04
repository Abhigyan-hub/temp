import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyAllSuggestions,
  companyFromEmail,
  contactSpellingSuggestions,
  extractContactsFromText,
  findSpellingSuggestions,
  htmlToBlocks,
  normalizeEmail,
  normalizeImportRow,
  resolveCompany,
  rowsFromTable,
} from "../src/shared/contactData.js";

describe("companyFromEmail", () => {
  const cases = {
    "hr@google.com": "Google",
    "careers@microsoft.com": "Microsoft",
    "jobs@amazon.in": "Amazon",
    "recruiter@infosys.co.in": "Infosys",
    "hr@tcs.com": "TCS",
    "careers@company.co.in": "Company",
    "jobs@careers.company.com": "Company",
    "admissions@iitb.ac.in": "Iitb",
    "a@www.mail.zoho.com": "Zoho",
    "x@tata-steel.com": "Tata Steel",
    "x@hr.recruitment.wipro.org": "Wipro",
    "x@ey.net": "EY",
    "x@stanford.edu": "Stanford",
    "  <HR@Google.COM>  ": "Google",
  };
  for (const [email, expected] of Object.entries(cases)) {
    test(`${email.trim()} → ${expected}`, () => assert.equal(companyFromEmail(email), expected));
  }

  test("free mail providers and invalid input give no company", () => {
    assert.equal(companyFromEmail("someone@gmail.com"), "");
    assert.equal(companyFromEmail("someone@yahoo.co.in"), "");
    assert.equal(companyFromEmail("not-an-email"), "");
    assert.equal(companyFromEmail(""), "");
  });

  test("resolveCompany keeps a manually entered company", () => {
    assert.equal(resolveCompany("Alphabet Inc", "hr@google.com"), "Alphabet Inc");
    assert.equal(resolveCompany("   ", "hr@google.com"), "Google");
  });
});

describe("spelling suggestions", () => {
  const typos = {
    carears: "careers",
    carreer: "career",
    recruter: "recruiter",
    corporat: "corporate",
    recriutment: "recruitment",
    indai: "india",
    compnay: "company",
  };
  for (const [wrong, right] of Object.entries(typos)) {
    test(`${wrong} → ${right}`, () => {
      const [s] = findSpellingSuggestions(wrong, "company");
      assert.equal(s?.to, right);
    });
  }

  test("email typo suggestion keeps the rest of the address", () => {
    const [s] = findSpellingSuggestions("carears@google.com", "email");
    assert.deepEqual(s, { from: "carears", to: "careers", original: "carears@google.com", suggestion: "careers@google.com" });
  });

  test("domain extension typos", () => {
    assert.equal(findSpellingSuggestions("hr@google.con", "email")[0]?.suggestion, "hr@google.com");
    assert.equal(findSpellingSuggestions("hr@google.cmo", "email")[0]?.suggestion, "hr@google.com");
    assert.equal(findSpellingSuggestions("hr@acme.ogr", "email")[0]?.suggestion, "hr@acme.org");
    assert.deepEqual(findSpellingSuggestions("hr@acme.ie", "email"), []);
    assert.deepEqual(findSpellingSuggestions("hr@acme.co.in", "email"), []);
  });

  test("keeps case when suggesting", () => {
    assert.equal(findSpellingSuggestions("Compnay Ltd", "company")[0].suggestion, "Company Ltd");
  });

  test("does not flag valid words, names, abbreviations or ordinary addresses", () => {
    for (const v of ["Google", "Infosys", "TCS", "HCL Technologies", "Carter", "Indian Oil", "Accenture", "Recruits"]) {
      assert.deepEqual(findSpellingSuggestions(v, "company"), [], v);
    }
    for (const v of ["john.carter@gmail.com", "priya@zeta.io", "careers@microsoft.com", "hr@company.co.in"]) {
      assert.deepEqual(findSpellingSuggestions(v, "email"), [], v);
    }
    for (const v of ["Priya Sharma", "Indai Kumar", "Carter Jones"]) {
      assert.deepEqual(findSpellingSuggestions(v, "name"), [], v);
    }
  });

  test("ignoring is the default: nothing is changed unless a suggestion is applied", () => {
    const value = "recruter@compnay.com";
    const found = findSpellingSuggestions(value, "email");
    assert.equal(found.length, 2);
    assert.equal(value, "recruter@compnay.com");
    assert.equal(found[0].suggestion, "recruiter@compnay.com");
    assert.equal(applyAllSuggestions(value, "email"), "recruiter@company.com");
  });

  test("contactSpellingSuggestions reports the field", () => {
    const s = contactSpellingSuggestions({ email: "carears@google.com", company: "Google", name: "Priya" });
    assert.deepEqual(s.map((x) => x.field), ["email"]);
  });
});

describe("import parsing", () => {
  test("normalizeImportRow maps header aliases and normalises email", () => {
    const r = normalizeImportRow({ "Full Name": "Ravi", "Email ID": " <Ravi@Acme.IO> ", Designation: "CTO", Organisation: "", Remarks: "met" });
    assert.deepEqual(r, { name: "Ravi", email: "ravi@acme.io", title: "CTO", company: "", category: "", notes: "met" });
  });

  test("normalizeEmail strips wrappers", () => {
    assert.equal(normalizeEmail("mailto:A@B.com,"), "a@b.com");
  });

  test("key/value blocks are structured", () => {
    const text = "Name: Priya Sharma\nEmail: priya@zeta.com\nTitle: HR Lead\nCompany: Zeta\n\nName: Rahul\nEmail: rahul@acme.in\nNotes: follow up";
    const { rows, structured } = extractContactsFromText(text);
    assert.equal(structured, true);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      { name: rows[0].name, email: rows[0].email, title: rows[0].title, company: rows[0].company },
      { name: "Priya Sharma", email: "priya@zeta.com", title: "HR Lead", company: "Zeta" },
    );
    assert.equal(rows[1].notes, "follow up");
  });

  test("free text extracts names only when clear and never invents data", () => {
    const text = [
      "Priya Sharma <priya@zeta.com>",
      "Rahul Verma - HR Manager at Acme - rahul@acme.in",
      "Contact us at careers@bigco.com for openings",
      "team: a@x.com, b@y.com",
      "random line without email",
    ].join("\n");
    const { rows, structured } = extractContactsFromText(text);
    assert.equal(structured, false);
    const by = Object.fromEntries(rows.map((r) => [r.email, r]));
    assert.equal(by["priya@zeta.com"].name, "Priya Sharma");
    assert.equal(by["rahul@acme.in"].name, "Rahul Verma");
    assert.equal(by["rahul@acme.in"].title, "HR Manager");
    assert.equal(by["rahul@acme.in"].company, "Acme");
    assert.equal(by["careers@bigco.com"].name, "");
    assert.equal(by["a@x.com"].name, "");
    assert.equal(rows.length, 5);
    assert.ok(by["priya@zeta.com"].source.includes("Priya Sharma"));
  });

  test("html tables with an email header become rows", () => {
    const html =
      "<p>Our list</p><table><tr><td><p>Name</p></td><td><p>Email</p></td><td><p>Company</p></td></tr>" +
      "<tr><td><p>Asha &amp; Co</p></td><td><p>asha@x.com</p></td><td><p></p></td></tr></table><p>Ravi ravi@y.com</p>";
    const { tables, text } = htmlToBlocks(html);
    assert.equal(tables.length, 1);
    const rows = rowsFromTable(tables[0]);
    assert.deepEqual([rows[0].name, rows[0].email, rows[0].company], ["Asha & Co", "asha@x.com", ""]);
    assert.match(text, /Ravi ravi@y\.com/);
    assert.equal(rowsFromTable([["Foo", "Bar"], ["1", "2"]]), null);
  });
});
