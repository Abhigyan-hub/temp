export { composeEmail, currentDateLabel, renderTemplate } from "../shared/templateRender.js";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Render the plain-text body as safe HTML (everything escaped, newlines preserved). */
export function textToHtml(text) {
  const paragraphs = escapeHtml(text)
    .split(/\r?\n\r?\n/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\r?\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:0"><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:640px">${paragraphs}</div></body></html>`;
}

/** Subjects are a single header line. */
export const cleanSubject = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
