import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useApp, type Contact, type ContactInput, type ContactStatus } from "@/lib/store";
import { errorMessage } from "@/lib/api";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Plus, Search, Upload, Ban, Trash2, Pencil, ArrowUpDown, Loader2, StickyNote, Download, MailCheck, UserRound } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContactProfileSheet } from "@/components/contact-profile-sheet";
import { ContactStatusBadge } from "@/components/contact-status-badge";
import { ContactsAnalytics } from "@/components/contacts-analytics";
import { EmailCorrectionDialog } from "@/components/email-correction-dialog";
import { CONTACT_INTEL_STATUSES } from "@shared/contactStatus.js";
import { BlockContactDialog, BlockFields } from "@/components/block-contact-dialog";
import { blockUntilFrom, blockUntilLabel, initialBlockValue, type BlockValue } from "@/lib/block";
import { ContactImportDialog } from "@/components/contact-import-dialog";
import { FieldSuggestions } from "@/components/spelling-suggestions";
import { companyFromEmail, isValidEmail, normalizeEmail } from "@/lib/contact-data";
import {
  ACCEPTED_IMPORT_TYPES,
  downloadContactTemplate,
  importFormatFor,
  parseContactFile,
  type ParsedImport,
} from "@/lib/contact-import";
import { formatDateTime } from "@/lib/datetime";
import { toast } from "sonner";

export const Route = createFileRoute("/contacts")({
  head: () => ({ meta: [{ title: "Contacts — MailFlow" }] }),
  component: ContactsPage,
});

const statusStyles: Record<ContactStatus, string> = {
  Pending: "bg-muted text-muted-foreground",
  Sent: "bg-accent/20 text-accent-foreground",
  Failed: "bg-destructive/15 text-destructive",
  Scheduled: "bg-primary/15 text-primary",
  Blocked: "bg-foreground/10 text-foreground/70",
};

type SortKey = "serialNo" | "name" | "company" | "category" | "status";

const time = (iso?: string | null) => (iso ? new Date(iso).getTime() : 0);
const bounceRate = (c: Contact) => ((c.hardBounceCount ?? 0) + (c.softBounceTotal ?? 0)) / Math.max(c.totalEmailsSent ?? 0, 1);

const ORDERINGS = {
  activity: { label: "Latest activity", compare: (a: Contact, b: Contact) => time(b.lastActivityAt) - time(a.lastActivityAt) },
  sent: { label: "Most emails sent", compare: (a: Contact, b: Contact) => (b.totalEmailsSent ?? 0) - (a.totalEmailsSent ?? 0) },
  bounce: { label: "Bounce rate", compare: (a: Contact, b: Contact) => bounceRate(b) - bounceRate(a) },
  replies: { label: "Replies", compare: (a: Contact, b: Contact) => (b.replyCount ?? 0) - (a.replyCount ?? 0) },
};

function ContactsPage() {
  const { contacts, contactsLoaded, loadContacts, importContacts, addContact, updateContact, deleteContact, setBlock } = useApp();
  const [blocking, setBlocking] = useState<Contact | null>(null);
  const timezone = useApp((s) => s.user?.settings.timezone);
  useAuthedLoad(() => loadContacts(), [contactsLoaded]);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [company, setCompany] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [orderBy, setOrderBy] = useState<keyof typeof ORDERINGS | "column">("column");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<Contact | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("serialNo");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [editing, setEditing] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [parsedImport, setParsedImport] = useState<ParsedImport | null>(null);
  const [importFile, setImportFile] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => Array.from(new Set(contacts.map((c) => c.category))).sort(), [contacts]);

  const companies = useMemo(() => Array.from(new Set(contacts.map((c) => c.company).filter(Boolean))).sort(), [contacts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = contacts.filter((c) => {
      const matchesQuery = !q || [c.name, c.email, c.company, c.title].some((f) => f.toLowerCase().includes(q));
      const matchesCat = category === "all" || c.category === category;
      const matchesCompany = company === "all" || c.company === company;
      const matchesStatus = statusFilter === "all" || c.contactStatus === statusFilter;
      return matchesQuery && matchesCat && matchesCompany && matchesStatus;
    });
    if (orderBy !== "column") return [...list].sort(ORDERINGS[orderBy].compare);
    list = [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [contacts, query, category, company, statusFilter, orderBy, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  const emailOwners = useMemo(() => new Map(contacts.map((c) => [c.email, c.id])), [contacts]);
  const existingEmails = useMemo(() => new Set(emailOwners.keys()), [emailOwners]);

  // Files are parsed in the browser and shown in a review dialog; the server re-validates on import.
  const handleFile = async (file: File) => {
    if (!importFormatFor(file.name)) {
      return toast.error("Upload a CSV, Excel (.xlsx/.xls), Word (.docx) or text (.txt) file");
    }
    setImporting(true);
    try {
      const result = await parseContactFile(file);
      if (result.rows.length === 0) {
        toast.warning("No email addresses found in this file");
        return;
      }
      setImportFile(file.name);
      setParsedImport(result);
    } catch (err) {
      toast.error(`Couldn't read ${file.name}: ${errorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <AppShell
      title="Contacts"
      actions={
        <>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_IMPORT_TYPES}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              downloadContactTemplate();
              toast.success("Template downloaded", { description: "Fill in your contacts and import the same file." });
            }}
            title="Download Excel Template"
          >
            <Download className="h-4 w-4 sm:mr-2" /> <span className="hidden sm:inline">Download Excel Template</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={importing}
            onClick={() => fileInput.current?.click()}
            title="Import CSV, Excel, Word (.docx) or text (.txt)"
          >
            {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />} Import
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </>
      }
    >
      <Tabs defaultValue="contacts">
      <TabsList className="mb-4">
        <TabsTrigger value="contacts">Contacts</TabsTrigger>
        <TabsTrigger value="analytics">Analytics &amp; follow-ups</TabsTrigger>
      </TabsList>
      <TabsContent value="contacts">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, email, company…" className="pl-9" />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full md:w-56"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
              </SelectContent>
            </Select>
            <Select value={company} onValueChange={setCompany}>
              <SelectTrigger className="w-full md:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All companies</SelectItem>
                {companies.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {CONTACT_INTEL_STATUSES.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
              </SelectContent>
            </Select>
            <Select value={orderBy} onValueChange={(v) => setOrderBy(v as typeof orderBy)}>
              <SelectTrigger className="w-full md:w-44" aria-label="Sort contacts"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="column">Sort: table columns</SelectItem>
                {Object.entries(ORDERINGS).map(([k, o]) => (<SelectItem key={k} value={k}>Sort: {o.label}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {(["serialNo", "name", "company", "category", "status"] as SortKey[]).map((k) => (
                    <TableHead key={k}>
                      <button className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider" onClick={() => toggleSort(k)}>
                        {k === "serialNo" ? "#" : k}
                        <ArrowUpDown className="h-3 w-3 opacity-50" />
                      </button>
                    </TableHead>
                  ))}
                  <TableHead>Email</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                      {contactsLoaded ? (
                        "No contacts found. Import a CSV, Excel, Word or text file, or add one manually."
                      ) : (
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      )}
                    </TableCell>
                  </TableRow>
                )}
                {visible.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted-foreground">{c.serialNo}</TableCell>
                    <TableCell>
                      <button className="block text-left font-medium hover:underline" onClick={() => setProfileId(c.id)}>
                        {c.name || <span className="font-normal text-muted-foreground">{c.email}</span>}
                      </button>
                      <div className="text-xs text-muted-foreground">{c.title}</div>
                      {c.notes && (
                        <div
                          className="mt-0.5 flex max-w-xs items-center gap-1 truncate text-xs text-muted-foreground/80"
                          title={c.noteUpdatedAt ? `${c.notes}\n\nLast updated: ${formatDateTime(c.noteUpdatedAt, timezone)}` : c.notes}
                        >
                          <StickyNote className="h-3 w-3 shrink-0" /> <span className="truncate">{c.notes}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{c.company}</TableCell>
                    <TableCell><Badge variant="outline">{c.category}</Badge></TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-xs ${statusStyles[c.status]}`}>{c.status}</span>
                        {!c.blocked && <ContactStatusBadge status={c.contactStatus} />}
                      </div>
                      {(c.totalEmailsSent ?? 0) > 0 && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {c.totalEmailsSent} sent{c.failedCount ? ` · ${c.failedCount} failed` : ""}{c.replyCount ? ` · ${c.replyCount} replied` : ""}
                        </div>
                      )}
                      {c.nextFollowUpAt && <div className="text-[11px] text-muted-foreground">Follow up {formatDateTime(c.nextFollowUpAt, timezone)}</div>}
                      {c.blocked && (
                        <div className="mt-1 max-w-[220px] text-[11px] leading-tight text-muted-foreground">
                          <div>{blockUntilLabel(c, timezone)}</div>
                          {c.blockReason && <div className="truncate" title={c.blockReason}>{c.blockReason}</div>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.email}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setProfileId(c.id)}><UserRound className="mr-2 h-4 w-4" /> View profile</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setEditing(c)}><Pencil className="mr-2 h-4 w-4" /> Edit</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setCorrecting(c)}><MailCheck className="mr-2 h-4 w-4" /> Correct email</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setBlocking(c)}>
                            <Ban className="mr-2 h-4 w-4" /> {c.blocked ? "Change block" : "Block…"}
                          </DropdownMenuItem>
                          {c.blocked && (
                            <DropdownMenuItem
                              onClick={() =>
                                setBlock(c.id, { blocked: false })
                                  .then(() => toast.success("Contact unblocked"))
                                  .catch((err) => toast.error(errorMessage(err)))
                              }
                            >
                              <Ban className="mr-2 h-4 w-4" /> Unblock
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => setDeleteId(c.id)}>
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      </TabsContent>
      <TabsContent value="analytics">
        <ContactsAnalytics onOpenContact={setProfileId} />
      </TabsContent>
      </Tabs>

      <ContactDialog
        open={creating || !!editing}
        contact={editing}
        emailOwners={emailOwners}
        timezone={timezone}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSave={async (data, block) => {
          try {
            if (editing) {
              await updateContact(editing.id, data);
              // Block status goes through the block/unblock endpoint.
              if (block) await setBlock(editing.id, block);
              toast.success("Contact updated");
            } else {
              await addContact(data);
              toast.success("Contact added");
            }
            setCreating(false);
            setEditing(null);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />

      <BlockContactDialog contact={blocking} onClose={() => setBlocking(null)} />
      <EmailCorrectionDialog contact={correcting} onClose={() => setCorrecting(null)} />
      <ContactProfileSheet contactId={profileId} onClose={() => setProfileId(null)} />

      <ContactImportDialog
        parsed={parsedImport}
        fileName={importFile}
        existingEmails={existingEmails}
        onClose={() => setParsedImport(null)}
        onImport={(rows) => importContacts(rows)}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) {
                  deleteContact(deleteId)
                    .then(() => toast.success("Deleted"))
                    .catch((err) => toast.error(errorMessage(err)));
                }
                setDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

function OptionalLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <Label htmlFor={htmlFor}>
      {children} <span className="font-normal text-muted-foreground">(optional)</span>
    </Label>
  );
}

function ContactDialog({
  open,
  contact,
  emailOwners,
  timezone,
  onClose,
  onSave,
}: {
  open: boolean;
  contact: Contact | null;
  /** email → contact id, for duplicate checks before saving. */
  emailOwners: Map<string, string>;
  timezone?: string;
  onClose: () => void;
  /** `block` is set only when the block status, reason or end date should change. */
  onSave: (data: ContactInput, block: { blocked: boolean; reason?: string; until?: string | null } | null) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  // The company value we filled in from the email; replaced when the email changes, unlike a typed one.
  const [autoCompany, setAutoCompany] = useState("");
  const [cat, setCat] = useState("Hiring");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [blockValue, setBlockValue] = useState<BlockValue>(initialBlockValue());
  const [blockEdited, setBlockEdited] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? "");
      setTitle(contact?.title ?? "");
      setCompany(contact?.company ?? "");
      setAutoCompany("");
      setCat(contact?.category ?? "Hiring");
      setEmail(contact?.email ?? "");
      setNotes(contact?.notes ?? "");
      setBlocked(contact?.blocked ?? false);
      setBlockValue(initialBlockValue(contact));
      setBlockEdited(false);
      setEmailTouched(false);
    }
  }, [open, contact]);

  const changeEmail = (value: string) => {
    setEmail(value);
    const derived = companyFromEmail(value);
    if (!company.trim() || company === autoCompany) {
      setCompany(derived);
      setAutoCompany(derived);
    }
  };

  const normalized = normalizeEmail(email);
  const owner = emailOwners.get(normalized);
  const emailError = !normalized
    ? "Email is required"
    : !isValidEmail(normalized)
      ? "Enter a valid email address"
      : owner && owner !== contact?.id
        ? "Another contact already uses this email"
        : "";
  const showEmailError = emailTouched && !!emailError;
  const notesChanged = (contact?.notes ?? "") !== notes;

  const save = async () => {
    setEmailTouched(true);
    if (emailError) return toast.error(emailError);
    let block: { blocked: boolean; reason?: string; until?: string | null } | null = null;
    // Only touch the block when it was switched on or its reason / duration was edited.
    if (contact && blocked && (!contact.blocked || blockEdited)) {
      const until = blockUntilFrom(blockValue);
      if ("error" in until) return toast.error(until.error);
      block = { blocked: true, reason: blockValue.reason.trim(), until: until.until };
    } else if (contact?.blocked && !blocked) {
      block = { blocked: false };
    }
    setSaving(true);
    await onSave({ name: name.trim(), title: title.trim(), company: company.trim(), category: cat.trim(), email: normalized, notes }, block);
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
          <DialogDescription>Only the email is required. Company is filled in from the email domain if left empty.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-2">
            <Label htmlFor="contact-email">
              Email <span className="text-destructive">*</span>
            </Label>
            <Input
              id="contact-email"
              type="email"
              value={email}
              aria-invalid={showEmailError}
              onChange={(e) => changeEmail(e.target.value)}
              onBlur={() => setEmailTouched(true)}
              placeholder="name@company.com"
            />
            {showEmailError && <p className="text-xs text-destructive">{emailError}</p>}
            <FieldSuggestions value={email} kind="email" onApply={(next) => changeEmail(next)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <OptionalLabel htmlFor="contact-name">Name</OptionalLabel>
              <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} />
              <FieldSuggestions value={name} kind="name" onApply={setName} />
            </div>
            <div className="space-y-2">
              <OptionalLabel htmlFor="contact-title">Title</OptionalLabel>
              <Input id="contact-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <FieldSuggestions value={title} kind="company" onApply={setTitle} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <OptionalLabel htmlFor="contact-company">Company</OptionalLabel>
              <Input
                id="contact-company"
                value={company}
                onChange={(e) => {
                  setCompany(e.target.value);
                  setAutoCompany("");
                }}
              />
              {company && company === autoCompany && (
                <p className="text-[11px] text-muted-foreground">Detected from the email domain. Edit to override.</p>
              )}
              <FieldSuggestions value={company} kind="company" onApply={(next) => { setCompany(next); setAutoCompany(""); }} />
            </div>
            <div className="space-y-2"><Label htmlFor="contact-category">Category</Label><Input id="contact-category" value={cat} onChange={(e) => setCat(e.target.value)} /></div>
          </div>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <OptionalLabel htmlFor="contact-notes">Notes</OptionalLabel>
              {contact?.noteUpdatedAt && !notesChanged && (
                <span className="text-[11px] text-muted-foreground">Last updated: {formatDateTime(contact.noteUpdatedAt, timezone)}</span>
              )}
              {notesChanged && contact && <span className="text-[11px] text-muted-foreground">Timestamp updates when you save</span>}
            </div>
            <Textarea id="contact-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering about this contact…" />
          </div>
          {contact && (
            <div className="space-y-3 rounded-md border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="contact-blocked">Blocked</Label>
                  <p className="text-xs text-muted-foreground">Blocked contacts are skipped when sending, with the reason shown.</p>
                </div>
                <Switch id="contact-blocked" checked={blocked} onCheckedChange={setBlocked} />
              </div>
              {blocked && (
                <BlockFields
                  value={blockValue}
                  onChange={(v) => {
                    setBlockValue(v);
                    setBlockEdited(true);
                  }}
                  timezone={timezone}
                />
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={save}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}