import type { ResumeFileType } from "./store";

export const RESUME_ACCEPT = ".pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword";

export const RESUME_TYPE_LABEL: Record<ResumeFileType, string> = {
  pdf: "PDF",
  docx: "DOCX",
  doc: "DOC",
};

export function formatBytes(bytes: number | undefined): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Quick client-side check before uploading; the server inspects the actual file content. */
export function resumeFileProblem(file: File, maxBytes?: number): string | null {
  if (!/\.(pdf|docx|doc)$/i.test(file.name)) return "Only PDF and Word (.docx, .doc) files";
  if (file.size === 0) return "The file is empty";
  if (maxBytes && file.size > maxBytes) return `Larger than ${formatBytes(maxBytes)}`;
  return null;
}
