import { create } from "zustand";
import type { ContactIntelStatus } from "@shared/contactStatus.js";
import { api, saveBlob, setUnauthorizedHandler } from "./api";

// Server-owned data lives in MongoDB; this store is an in-memory cache of it for the UI.
// Nothing here is persisted to localStorage (theme preference is handled separately in theme.tsx).

export type ContactStatus = "Pending" | "Scheduled" | "Sent" | "Failed" | "Blocked";

export interface Contact {
  id: string;
  serialNo: number;
  name: string;
  title: string;
  company: string;
  category: string;
  email: string;
  emailStatus: Exclude<ContactStatus, "Blocked">;
  /** Display status: "Blocked" when blocked, otherwise the email status. */
  status: ContactStatus;
  blocked: boolean;
  notes: string;
  /** When the notes last changed (ISO, UTC). Null when there are no notes. */
  noteUpdatedAt?: string | null;
  createdAt: string;
  lastEmailedAt?: string;
  blockReason: string;
  blockedAt: string | null;
  /** Block end (ISO). Null while blocked = until manually unblocked. */
  blockedUntil: string | null;
  isBlocked: boolean;
  updatedAt: string;
  // Deliverability
  contactStatus: ContactIntelStatus;
  emailValidity: "Unknown" | "Valid" | "Invalid";
  /** "Accepted" means the SMTP server took the email, not that it was delivered. */
  deliveryStatus: "None" | "Accepted" | "Failed" | "Bounced";
  bounceStatus: "None" | "Soft" | "Hard" | "Temporary" | "Rejected";
  bounceReason: string;
  replyStatus: "None" | "Replied" | "Auto Replied";
  unsubscribed: boolean;
  softBounceCount: number;
  softBounceRetryAt: string | null;
  // Counters (send attempts)
  totalEmailsSent: number;
  acceptedCount: number;
  failedCount: number;
  hardBounceCount: number;
  softBounceTotal: number;
  replyCount: number;
  lastEmailStatus: string;
  lastEmailReceivedAt: string | null;
  lastRepliedAt: string | null;
  lastBounceAt: string | null;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  addressHistory: { email: string; status: string; reason: string; changedAt: string }[];
}

/** A user's own SMTP sender. The password never reaches the browser. */
export interface EmailAccount {
  id: string;
  label: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls";
  smtpUsername: string;
  imapEnabled: boolean;
  imapHost: string;
  imapPort: number;
  isDefault: boolean;
  hasPassword: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string;
}

export type EmailAccountInput = Omit<EmailAccount, "id" | "isDefault" | "hasPassword" | "lastTestAt" | "lastTestOk" | "lastTestError"> & { password?: string };

export interface EmailAccountsInfo {
  accounts: EmailAccount[];
  sendingMode: "system" | "custom";
  system: { senderEmail: string; host: string; port: number; secure: boolean };
  encryptionConfigured: boolean;
}

/** Info about a contact skipped because it's blocked. */
export interface BlockedRecipient {
  contactId: string;
  name: string;
  email: string;
  reason: string;
  until: string | null;
  message: string;
}

export interface Template {
  id: string;
  templateName: string;
  category: string;
  subject: string;
  body: string;
  favorite: boolean;
  createdAt: string;
  defaultResumeId: string | null;
}

export type ScheduleStatus = "Pending" | "Processing" | "Sent" | "Failed" | "Cancelled";

export interface EmailSchedule {
  id: string;
  contactId: string;
  templateId: string;
  scheduledAt: string; // ISO, UTC
  timezone: string;
  status: ScheduleStatus;
  comments: string;
  errorMessage: string;
  processedAt?: string;
  contact: { id: string; name: string; email: string; company: string } | null;
  template: { id: string; name: string } | null;
  resumeIds: string[];
  attachments: Attachment[];
}

/** Attachment metadata on schedules and email history (never the file itself). */
export interface Attachment {
  resumeId: string;
  fileName: string;
  displayName?: string;
  fileType?: ResumeFileType;
  fileSize?: number;
  /** The resume was deleted from the library after the email was scheduled. */
  missing?: boolean;
}

export interface EmailHistoryItem {
  id: string;
  contactId?: string;
  templateId?: string;
  recipient: string;
  subject: string;
  status: "Sent" | "Failed";
  errorMessage: string;
  source: "manual" | "scheduled" | "test";
  sentAt: string;
  attachments?: Attachment[];
  /** Built but not delivered (server in dry-run mode). */
  dryRun?: boolean;
}

export type ResumeFileType = "pdf" | "docx" | "doc";

export interface Resume {
  id: string;
  name: string;
  originalFileName: string;
  fileType: ResumeFileType;
  mimeType: string;
  fileSize: number;
  category: string;
  description: string;
  labels: string[];
  uploadedAt: string;
  updatedAt: string;
}

export interface ResumeCategory {
  id: string;
  name: string;
  resumeCount: number;
}

export interface ResumeLibraryStatus {
  storage: { configured: boolean; driver?: string; reason?: string };
  limits: { maxFileBytes: number; maxFilesPerUpload: number; maxResumes: number; maxAttachments: number; maxAttachmentBytes: number };
}

export interface ResumeUploadResult {
  uploaded: Resume[];
  duplicates: { fileName: string; existing: { id: string; name: string } | null }[];
  rejected: { fileName: string; reason: string }[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  profile: { senderName: string; signature: string };
  settings: { timezone: string; defaultSendTime: string; sendingMode?: "system" | "custom" };
}

export interface Stats {
  totalContacts: number;
  blockedContacts: number;
  notContacted: number;
  totalEmails: number;
  sent: number;
  failed: number;
  successRate: number;
  pendingSchedules: number;
  sentLast24h: number;
  dailyLimit: number;
  /** "dry-run" when the server builds emails without delivering them. */
  emailMode: "live" | "dry-run";
  timezone: string;
  daily: { date: string; sent: number; failed: number }[];
  categories: { name: string; value: number }[];
  recent: EmailHistoryItem[];
}

export interface ImportResult {
  total: number;
  imported: number;
  duplicates: number;
  invalid: number;
  /** New contacts without a name, title or company. */
  missingOptional: number;
  /** New contacts whose company was filled in from the email domain. */
  companyFromEmail: number;
  errors: { row: number; message: string }[];
}

export type ContactInput = { name: string; title: string; company: string; category: string; email: string; notes: string };
export type TemplateInput = { templateName: string; category: string; subject: string; body: string; defaultResumeId?: string | null };

type RawContact = Omit<Contact, "status" | "blocked"> & { isBlocked: boolean };
type RawTemplate = { id: string; name: string; category: string; subject: string; body: string; isFavorite: boolean; createdAt: string; defaultResumeId?: string | null };

const toContact = (c: RawContact): Contact => ({
  ...c,
  blocked: c.isBlocked,
  status: c.isBlocked ? "Blocked" : c.emailStatus,
});

const toTemplate = (t: RawTemplate): Template => ({
  id: t.id,
  templateName: t.name,
  category: t.category,
  subject: t.subject,
  body: t.body,
  favorite: t.isFavorite,
  createdAt: t.createdAt,
  defaultResumeId: t.defaultResumeId ?? null,
});

const fromTemplateInput = (t: Partial<TemplateInput>) => ({
  name: t.templateName,
  category: t.category,
  subject: t.subject,
  body: t.body,
  defaultResumeId: t.defaultResumeId,
});

// De-duplicate concurrent loads of the same resource (several components mounting at once).
const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

type AuthStatus = "unknown" | "authenticated" | "guest";

interface AppState {
  user: User | null;
  authStatus: AuthStatus;
  checkAuth: () => Promise<User | null>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateSettings: (patch: {
    name?: string;
    email?: string;
    profile?: Partial<User["profile"]>;
    settings?: Partial<User["settings"]>;
  }) => Promise<void>;

  contacts: Contact[];
  categories: string[];
  contactsLoaded: boolean;
  loadContacts: (force?: boolean) => Promise<void>;
  addContact: (c: ContactInput) => Promise<void>;
  updateContact: (id: string, patch: Partial<ContactInput>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  /** Block (with an optional reason and end date; until null = until unblocked) or unblock. */
  setBlock: (id: string, block: { blocked: boolean; reason?: string; until?: string | null }) => Promise<void>;
  importContacts: (rows: object[]) => Promise<ImportResult>;

  templates: Template[];
  templatesLoaded: boolean;
  loadTemplates: (force?: boolean) => Promise<void>;
  addTemplate: (t: TemplateInput) => Promise<void>;
  updateTemplate: (id: string, patch: Partial<TemplateInput>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  duplicateTemplate: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;

  schedules: EmailSchedule[];
  schedulesLoaded: boolean;
  loadSchedules: (force?: boolean) => Promise<void>;
  createSchedules: (s: {
    templateId: string;
    contactIds: string[];
    scheduledAt: string;
    comments?: string;
    resumeIds?: string[];
    emailAccountId?: string;
  }) => Promise<{ scheduled: number; skipped: number; blocked: BlockedRecipient[] }>;
  updateSchedule: (id: string, patch: { scheduledAt?: string; comments?: string }) => Promise<void>;
  cancelSchedule: (id: string) => Promise<void>;
  sendScheduleNow: (id: string) => Promise<EmailSchedule>;
  deleteSchedule: (id: string) => Promise<void>;

  sendTestEmail: () => Promise<string>;

  /** Put a contact returned by the API into the cache (after a status change, new note…). */
  mergeContact: (raw: unknown) => void;

  emailAccounts: EmailAccountsInfo | null;
  loadEmailAccounts: (force?: boolean) => Promise<void>;
  saveEmailAccount: (id: string | null, input: Partial<EmailAccountInput>) => Promise<void>;
  deleteEmailAccount: (id: string) => Promise<void>;
  setDefaultEmailAccount: (id: string) => Promise<void>;
  setSendingMode: (mode: "system" | "custom") => Promise<void>;

  stats: Stats | null;
  loadStats: () => Promise<void>;

  resumes: Resume[];
  resumesLoaded: boolean;
  resumeStatus: ResumeLibraryStatus | null;
  resumeCategories: ResumeCategory[];
  resumeCategoriesLoaded: boolean;
  loadResumes: (force?: boolean) => Promise<void>;
  loadResumeStatus: () => Promise<void>;
  loadResumeCategories: (force?: boolean) => Promise<void>;
  uploadResumes: (
    files: File[],
    fields: { category?: string; description?: string },
    onProgress?: (fraction: number) => void,
  ) => Promise<ResumeUploadResult>;
  updateResume: (id: string, patch: Partial<Pick<Resume, "name" | "description" | "category" | "labels">>) => Promise<void>;
  deleteResume: (id: string) => Promise<void>;
  downloadResume: (resume: Resume) => Promise<void>;
  fetchResumeFile: (id: string) => Promise<Blob>;
  createResumeCategory: (name: string) => Promise<void>;
  renameResumeCategory: (id: string, name: string) => Promise<void>;
  deleteResumeCategory: (id: string) => Promise<void>;
}

const emptyData = {
  contacts: [] as Contact[],
  categories: [] as string[],
  contactsLoaded: false,
  templates: [] as Template[],
  templatesLoaded: false,
  schedules: [] as EmailSchedule[],
  schedulesLoaded: false,
  stats: null as Stats | null,
  resumes: [] as Resume[],
  resumesLoaded: false,
  resumeStatus: null as ResumeLibraryStatus | null,
  resumeCategories: [] as ResumeCategory[],
  resumeCategoriesLoaded: false,
  emailAccounts: null as EmailAccountsInfo | null,
};

/** "Khushant MERN Resume" + pdf → "Khushant_MERN_Resume.pdf" (matches the server's attachment name). */
export const resumeFileName = (r: Pick<Resume, "name" | "fileType">) =>
  `${r.name.replace(/[<>:"/\\|?*]+/g, " ").trim().replace(/\s+/g, "_") || "Resume"}.${r.fileType}`;

export const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const useApp = create<AppState>()((set, get) => {
  const replaceContact = (raw: RawContact) =>
    set((s) => ({ contacts: s.contacts.map((c) => (c.id === raw.id ? toContact(raw) : c)) }));
  const replaceTemplate = (raw: RawTemplate) =>
    set((s) => ({ templates: s.templates.map((t) => (t.id === raw.id ? toTemplate(raw) : t)) }));
  const replaceSchedule = (sc: EmailSchedule) =>
    set((s) => ({ schedules: s.schedules.map((x) => (x.id === sc.id ? sc : x)) }));
  const refreshContactCategories = () =>
    set((s) => ({ categories: Array.from(new Set(s.contacts.map((c) => c.category))).sort() }));

  return {
    user: null,
    authStatus: "unknown",
    ...emptyData,

    checkAuth: () =>
      once("auth", async () => {
        try {
          const { user } = await api.get<{ user: User }>("/auth/me");
          set({ user, authStatus: "authenticated" });
          return user;
        } catch {
          set({ user: null, authStatus: "guest" });
          return null;
        }
      }),
    login: async (email, password) => {
      const { user } = await api.post<{ user: User }>("/auth/login", { email, password });
      set({ ...emptyData, user, authStatus: "authenticated" });
    },
    register: async (name, email, password) => {
      const { user } = await api.post<{ user: User }>("/auth/register", { name, email, password });
      set({ ...emptyData, user, authStatus: "authenticated" });
    },
    logout: async () => {
      try {
        await api.post("/auth/logout");
      } finally {
        set({ ...emptyData, user: null, authStatus: "guest" });
      }
    },
    updateSettings: async (patch) => {
      const { user } = await api.put<{ user: User }>("/settings", patch);
      set({ user });
    },

    loadContacts: (force) =>
      get().contactsLoaded && !force
        ? Promise.resolve()
        : once("contacts", async () => {
            const res = await api.get<{ contacts: RawContact[]; categories: string[] }>("/contacts");
            set({ contacts: res.contacts.map(toContact), categories: res.categories, contactsLoaded: true });
          }),
    addContact: async (c) => {
      const { contact } = await api.post<{ contact: RawContact }>("/contacts", c);
      set((s) => ({ contacts: [...s.contacts, toContact(contact)] }));
      refreshContactCategories();
    },
    updateContact: async (id, patch) => {
      const { contact } = await api.put<{ contact: RawContact }>(`/contacts/${id}`, patch);
      replaceContact(contact);
      refreshContactCategories();
    },
    deleteContact: async (id) => {
      await api.del(`/contacts/${id}`);
      set((s) => ({ contacts: s.contacts.filter((c) => c.id !== id), schedulesLoaded: false }));
      refreshContactCategories();
    },
    setBlock: async (id, block) => {
      const { contact } = await api.patch<{ contact: RawContact }>(`/contacts/${id}/block`, block);
      replaceContact(contact);
      if (contact.isBlocked) set({ schedulesLoaded: false });
    },
    importContacts: async (rows) => {
      const result = await api.post<ImportResult>("/contacts/import", { contacts: rows });
      if (result.imported) await get().loadContacts(true);
      return result;
    },

    loadTemplates: (force) =>
      get().templatesLoaded && !force
        ? Promise.resolve()
        : once("templates", async () => {
            const { templates } = await api.get<{ templates: RawTemplate[] }>("/templates");
            set({ templates: templates.map(toTemplate), templatesLoaded: true });
          }),
    addTemplate: async (t) => {
      const { template } = await api.post<{ template: RawTemplate }>("/templates", fromTemplateInput(t));
      set((s) => ({ templates: [...s.templates, toTemplate(template)] }));
    },
    updateTemplate: async (id, patch) => {
      const { template } = await api.put<{ template: RawTemplate }>(`/templates/${id}`, fromTemplateInput(patch));
      replaceTemplate(template);
    },
    deleteTemplate: async (id) => {
      await api.del(`/templates/${id}`);
      set((s) => ({ templates: s.templates.filter((t) => t.id !== id), schedulesLoaded: false }));
    },
    duplicateTemplate: async (id) => {
      const { template } = await api.post<{ template: RawTemplate }>(`/templates/${id}/duplicate`);
      set((s) => ({ templates: [...s.templates, toTemplate(template)] }));
    },
    toggleFavorite: async (id) => {
      const { template } = await api.patch<{ template: RawTemplate }>(`/templates/${id}/favorite`);
      replaceTemplate(template);
    },

    loadSchedules: (force) =>
      get().schedulesLoaded && !force
        ? Promise.resolve()
        : once("schedules", async () => {
            const { schedules } = await api.get<{ schedules: EmailSchedule[] }>("/schedules");
            set({ schedules, schedulesLoaded: true });
          }),
    createSchedules: async ({ templateId, contactIds, scheduledAt, comments, resumeIds, emailAccountId }) => {
      const res = await api.post<{ scheduled: number; skipped: number; blocked: BlockedRecipient[]; schedules: EmailSchedule[] }>("/schedules", {
        templateId,
        contactIds,
        scheduledAt,
        comments,
        resumeIds: resumeIds ?? [],
        ...(emailAccountId ? { emailAccountId } : {}),
        timezone: get().user?.settings.timezone || browserTimezone(),
      });
      set((s) => ({ schedules: [...s.schedules, ...res.schedules], contactsLoaded: false }));
      return { scheduled: res.scheduled, skipped: res.skipped, blocked: res.blocked ?? [] };
    },
    updateSchedule: async (id, patch) => {
      const { schedule } = await api.patch<{ schedule: EmailSchedule }>(`/schedules/${id}`, patch);
      replaceSchedule(schedule);
    },
    cancelSchedule: async (id) => {
      const { schedule } = await api.patch<{ schedule: EmailSchedule }>(`/schedules/${id}/cancel`);
      replaceSchedule(schedule);
      set({ contactsLoaded: false });
    },
    sendScheduleNow: async (id) => {
      const { schedule } = await api.post<{ schedule: EmailSchedule }>(`/schedules/${id}/send-now`);
      replaceSchedule(schedule);
      set({ contactsLoaded: false });
      return schedule;
    },
    deleteSchedule: async (id) => {
      await api.del(`/schedules/${id}`);
      set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id), contactsLoaded: false }));
    },

    mergeContact: (raw) => replaceContact(raw as RawContact),

    loadEmailAccounts: (force) =>
      get().emailAccounts && !force
        ? Promise.resolve()
        : once("email-accounts", async () => {
            const info = await api.get<EmailAccountsInfo>("/email-accounts");
            set({ emailAccounts: { accounts: info.accounts, sendingMode: info.sendingMode, system: info.system, encryptionConfigured: info.encryptionConfigured } });
          }),
    saveEmailAccount: async (id, input) => {
      if (id) await api.put(`/email-accounts/${id}`, input);
      else await api.post("/email-accounts", input);
      await get().loadEmailAccounts(true);
    },
    deleteEmailAccount: async (id) => {
      await api.del(`/email-accounts/${id}`);
      await get().loadEmailAccounts(true);
    },
    setDefaultEmailAccount: async (id) => {
      await api.post(`/email-accounts/${id}/default`);
      await get().loadEmailAccounts(true);
    },
    setSendingMode: async (sendingMode) => {
      await get().updateSettings({ settings: { sendingMode } });
      await get().loadEmailAccounts(true);
    },
    sendTestEmail: async () => (await api.post<{ message: string }>("/emails/test")).message,

    loadStats: () =>
      once("stats", async () => {
        const { stats } = await api.get<{ stats: Stats }>("/emails/stats");
        set({ stats });
      }),

    loadResumes: (force) =>
      get().resumesLoaded && !force
        ? Promise.resolve()
        : once("resumes", async () => {
            const { resumes } = await api.get<{ resumes: Resume[] }>("/resumes");
            set({ resumes, resumesLoaded: true });
          }),
    loadResumeStatus: () =>
      get().resumeStatus
        ? Promise.resolve()
        : once("resume-status", async () => {
            const status = await api.get<ResumeLibraryStatus>("/resumes/status");
            set({ resumeStatus: { storage: status.storage, limits: status.limits } });
          }),
    loadResumeCategories: (force) =>
      get().resumeCategoriesLoaded && !force
        ? Promise.resolve()
        : once("resume-categories", async () => {
            const { categories } = await api.get<{ categories: ResumeCategory[] }>("/resume-categories");
            set({ resumeCategories: categories, resumeCategoriesLoaded: true });
          }),
    uploadResumes: async (files, fields, onProgress) => {
      const form = new FormData();
      if (fields.category) form.append("category", fields.category);
      if (fields.description) form.append("description", fields.description);
      files.forEach((f) => form.append("files", f, f.name));
      const result = await api.upload<ResumeUploadResult>("/resumes/upload", form, onProgress);
      if (result.uploaded.length) {
        set((s) => ({ resumes: [...result.uploaded, ...s.resumes] }));
        await get().loadResumeCategories(true);
      }
      return result;
    },
    updateResume: async (id, patch) => {
      const { resume } = await api.put<{ resume: Resume }>(`/resumes/${id}`, patch);
      set((s) => ({ resumes: s.resumes.map((r) => (r.id === id ? resume : r)) }));
      if (patch.category !== undefined) await get().loadResumeCategories(true);
    },
    deleteResume: async (id) => {
      await api.del(`/resumes/${id}`);
      set((s) => ({ resumes: s.resumes.filter((r) => r.id !== id) }));
      await get().loadResumeCategories(true);
    },
    fetchResumeFile: (id) => api.blob(`/resumes/${id}/download?inline=1`),
    downloadResume: async (resume) => {
      saveBlob(await api.blob(`/resumes/${resume.id}/download`), resumeFileName(resume));
    },
    createResumeCategory: async (name) => {
      const { category } = await api.post<{ category: ResumeCategory }>("/resume-categories", { name });
      set((s) => ({ resumeCategories: [...s.resumeCategories, category].sort((a, b) => a.name.localeCompare(b.name)) }));
    },
    renameResumeCategory: async (id, name) => {
      const { categories } = await api.put<{ categories: ResumeCategory[] }>(`/resume-categories/${id}`, { name });
      set({ resumeCategories: categories });
      await get().loadResumes(true);
    },
    deleteResumeCategory: async (id) => {
      const { categories } = await api.del<{ categories: ResumeCategory[] }>(`/resume-categories/${id}`);
      set({ resumeCategories: categories });
      await get().loadResumes(true);
    },
  };
});

setUnauthorizedHandler(() => useApp.setState({ ...emptyData, user: null, authStatus: "guest" }));

// The server's own renderer, so previews show exactly what gets sent.
export { composeEmail, currentDateLabel, insertAtCursor, renderTemplate } from "@shared/templateRender.js";
