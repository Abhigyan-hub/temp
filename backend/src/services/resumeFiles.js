import fsp from "node:fs/promises";

export const RESUME_TYPES = {
  pdf: { ext: "pdf", mime: "application/pdf", label: "PDF" },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word (.docx)" },
  doc: { ext: "doc", mime: "application/msword", label: "Word 97-2003 (.doc)" },
};

const utf16 = (s) => Buffer.from(s, "utf16le");
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export class InvalidResumeError extends Error {}

/**
 * Identify a resume by its bytes (never the extension) and reject anything that isn't a
 * plain PDF / Word document. Files are capped by the upload limit, so reading them is bounded.
 */
export async function detectResumeType(filePath, originalName) {
  const buf = await fsp.readFile(filePath);
  if (buf.length === 0) throw new InvalidResumeError("The file is empty");

  let type;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    const text = buf.toString("latin1");
    // Active content has no place in a resume and is a common malware vector.
    if (/\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(text)) {
      throw new InvalidResumeError("This PDF contains scripts or embedded files, which aren't allowed");
    }
    type = "pdf";
  } else if (buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    // ZIP entry names are stored uncompressed, so a byte search finds them.
    if (!buf.includes("word/document.xml") || !buf.includes("[Content_Types].xml")) {
      throw new InvalidResumeError("This ZIP file is not a Word document");
    }
    if (buf.includes("vbaProject.bin")) throw new InvalidResumeError("Word files with macros aren't allowed");
    type = "docx";
  } else if (buf.subarray(0, 8).equals(CFB_MAGIC)) {
    if (!buf.includes(utf16("WordDocument"))) throw new InvalidResumeError("This file is not a Word document");
    if (buf.includes(utf16("Macros")) || buf.includes(utf16("_VBA_PROJECT"))) {
      throw new InvalidResumeError("Word files with macros aren't allowed");
    }
    type = "doc";
  } else {
    throw new InvalidResumeError("Only PDF and Word (.docx, .doc) files can be uploaded");
  }

  const ext = String(originalName ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && ext !== type) {
    throw new InvalidResumeError(`The file content is ${RESUME_TYPES[type].label}, but its name ends in .${ext}`);
  }
  return RESUME_TYPES[type];
}

/** Display name from an uploaded filename: no path, no extension, no control or reserved characters. */
export function displayNameFrom(originalName) {
  const base = String(originalName ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.[a-z0-9]{1,5}$/i, "");
  return cleanName(base) || "Resume";
}

export function cleanName(name) {
  return String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
}

/** Attachment / download filename: "Khushant MERN Resume" → "Khushant_MERN_Resume.pdf". */
export function fileNameFor(resume) {
  const safe = cleanName(resume.name).replace(/\s+/g, "_") || "Resume";
  return `${safe}.${resume.fileType}`;
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(type, fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
