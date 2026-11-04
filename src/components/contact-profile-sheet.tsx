import { useCallback, useEffect, useState } from "react";
import { Ban, CalendarClock, CheckCircle2, Clock, History, Loader2, Mail, Paperclip, Pencil, Reply, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BlockContactDialog } from "@/components/block-contact-dialog";
import { ContactStatusBadge } from "@/components/contact-status-badge";
import { EmailCorrectionDialog } from "@/components/email-correction-dialog";
import { api, errorMessage } from "@/lib/api";
import { blockUntilLabel } from "@/lib/block";
import { formatDateTime } from "@/lib/datetime";
import { formatBytes } from "@/lib/files";
import { useApp, type Attachment, type Contact } from "@/lib/store";
import { sendRestriction } from "../../backend/src/shared/contactStatus.js";

interface Activity {
  id: string;
  activityType: string;
  description: string;
  occurredAt: string;
  metadata?: { subject?: string; template?: string; attachments?: string[]; status?: string };
}
interface HistoryRow {
  id: string;
  subject: string;
  templateName: string;
  recipient: string;
  senderEmail: string;
  status: "Sent" | "Failed";
  errorMessage: string;
  outcome: string;
  dryRun?: boolean;
  source: string;
  sentAt: string;
  attachments?: Attachment[];
}
interface IncomingRow {
  id: string;
  senderEmail: string;
  subject: string;
  bodyPreview: string;
  classification: string;
  matchedBy: string;
  receivedAt: string;
  bounce?: { status?: string; diagnostic?: string; finalRecipient?: string };
}
interface NoteRow {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  versions: { text: string; savedAt: string }[];
}
interface FollowUpRow {
  id: string;
  dueAt: string;
  note: string;
  status: "Pending" | "Done" | "Cancelled";
  completedAt: string | null;
}

const CLASSIFICATION_LABEL: Record<string, string> = {
  hard_bounce: "Hard bounce",
  soft_bounce: "Soft bounce",
  temporary_rejection: "Temporarily rejected",
  rejected: "Rejected by server",
  complaint: "Spam complaint",
  auto_reply: "Automatic reply",
  out_of_office: "Out of office",
  human_reply: "Reply",
};

// "Blocked" has its own dialog so a reason and duration are always recorded.
const MANUAL_STATUSES: Contact["contactStatus"][] = ["Unknown", "Valid", "Invalid", "Hard Bounced", "Soft Bounced", "Temporarily Rejected", "Bounced", "Replied", "Auto Replied", "Unsubscribed"];

/** The full picture of one contact. Also used as the quick-detail panel in Compose. */
export function ContactProfileSheet({ contactId, onClose }: { contactId: string | null; onClose: () => void }) {
  const contact = useApp((s) => s.contacts.find((c) => c.id === contactId) ?? null);
  const timezone = useApp((s) => s.user?.settings.timezone);
  const setBlock = useApp((s) => s.setBlock);
  const mergeContact = useApp((s) => s.mergeContact);

  const [activities, setActivities] = useState<Activity[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [incoming, setIncoming] = useState<IncomingRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [correcting, setCorrecting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<Contact["contactStatus"] | null>(null);
  const [statusReason, setStatusReason] = useState("");

  const fmt = (iso?: string | null) => (iso ? formatDateTime(iso, timezone) : "—");

  const refresh = useCallback(async () => {
    if (!contactId) return;
    const [a, h, i, n, f] = await Promise.all([
      api.get<{ activities: Activity[] }>(`/contacts/${contactId}/activity`),
      api.get<{ history: HistoryRow[] }>(`/contacts/${contactId}/email-history`),
      api.get<{ messages: IncomingRow[] }>(`/contacts/${contactId}/incoming`),
      api.get<{ notes: NoteRow[] }>(`/contacts/${contactId}/notes`),
      api.get<{ followUps: FollowUpRow[] }>(`/contacts/${contactId}/follow-ups`),
    ]);
    setActivities(a.activities);
    setHistory(h.history);
    setIncoming(i.messages);
    setNotes(n.notes);
    setFollowUps(f.followUps);
  }, [contactId]);

  useEffect(() => {
    if (!contactId) return;
    setLoading(true);
    refresh()
      .catch((err) => toast.error(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [contactId, refresh]);

  const applyStatus = async () => {
    if (!contact || !pendingStatus) return;
    try {
      const res = await api.patch<{ contact: unknown }>(`/contacts/${contact.id}/status`, { status: pendingStatus, confirm: true, reason: statusReason.trim() });
      mergeContact(res.contact);
      toast.success("Status updated");
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPendingStatus(null);
      setStatusReason("");
    }
  };

  const restriction = contact ? sendRestriction(contact) : null;

  return (
    <Sheet open={!!contactId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {!contact ? (
          <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <>
            <SheetHeader className="space-y-1 pr-6 text-left">
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <span className="break-all">{contact.name || contact.email}</span>
                <ContactStatusBadge status={contact.contactStatus} />
              </SheetTitle>
              <SheetDescription className="break-all">
                {contact.email}
                {contact.title || contact.company ? ` · ${[contact.title, contact.company].filter(Boolean).join(" at ")}` : ""}
              </SheetDescription>
            </SheetHeader>

            {restriction && (
              <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Not being emailed. {contact.blocked ? `${blockUntilLabel(contact, timezone)}${contact.blockReason ? `: ${contact.blockReason}` : ""}` : restriction.message}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setCorrecting(true)}><Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit email</Button>
              <Button size="sm" variant="outline" onClick={() => setBlocking(true)}><Ban className="mr-1.5 h-3.5 w-3.5" /> {contact.blocked ? "Change block" : "Block…"}</Button>
              {contact.blocked && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBlock(contact.id, { blocked: false }).then(() => { toast.success("Contact unblocked"); return refresh(); }).catch((err) => toast.error(errorMessage(err)))}
                >
                  Unblock
                </Button>
              )}
              <Select value="" onValueChange={(v) => setPendingStatus(v as Contact["contactStatus"])}>
                <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Correct the status…" /></SelectTrigger>
                <SelectContent>
                  {MANUAL_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <Tabs defaultValue="overview" className="mt-4">
              <TabsList className="flex h-auto flex-wrap justify-start">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="emails">Emails ({history.length + incoming.length})</TabsTrigger>
                <TabsTrigger value="notes">Notes ({notes.length})</TabsTrigger>
                <TabsTrigger value="followups">Follow-ups</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                  <Field label="Job title" value={contact.title} />
                  <Field label="Company" value={contact.company} />
                  <Field label="Category" value={contact.category} />
                  <Field label="Email validity" value={contact.emailValidity} />
                  <Field label="Delivery status" value={contact.deliveryStatus === "Accepted" ? "Accepted by server" : contact.deliveryStatus} hint={contact.deliveryStatus === "Accepted" ? "Not proof of inbox delivery" : undefined} />
                  <Field label="Bounce status" value={contact.bounceStatus} hint={contact.bounceReason || undefined} />
                  <Field label="Reply status" value={contact.replyStatus} />
                  <Field label="Block status" value={contact.blocked ? blockUntilLabel(contact, timezone) : "Not blocked"} />
                  <Field label="Total emails sent" value={String(contact.totalEmailsSent ?? 0)} />
                  <Field label="Accepted by server" value={String(contact.acceptedCount ?? 0)} />
                  <Field label="Failed" value={String(contact.failedCount ?? 0)} />
                  <Field label="Replies" value={String(contact.replyCount ?? 0)} />
                  <Field label="Last email sent" value={fmt(contact.lastEmailedAt)} />
                  <Field label="Last email received" value={fmt(contact.lastEmailReceivedAt)} />
                  <Field label="Last follow-up" value={fmt(contact.lastFollowUpAt)} />
                  <Field label="Next follow-up" value={fmt(contact.nextFollowUpAt)} />
                  <Field label="Created" value={fmt(contact.createdAt)} />
                  <Field label="Last updated" value={fmt(contact.updatedAt)} />
                </dl>
                {contact.addressHistory?.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Previous addresses</p>
                    <ul className="divide-y divide-border rounded-md border border-border text-sm">
                      {contact.addressHistory.map((a, i) => (
                        <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                          <span className="break-all">{a.email}</span>
                          <span className="text-xs text-muted-foreground">{a.status} · changed {fmt(a.changedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="timeline">
                {loading ? <Spinner /> : activities.length === 0 ? <Empty text="No activity yet." /> : (
                  <ol className="space-y-3 border-l border-border pl-4">
                    {activities.map((a) => (
                      <li key={a.id} className="relative">
                        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" />
                        <p className="text-sm">{a.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {fmt(a.occurredAt)}
                          {a.metadata?.template ? ` · Template: ${a.metadata.template}` : ""}
                        </p>
                        {a.metadata?.attachments && a.metadata.attachments.length > 0 && (
                          <p className="flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="h-3 w-3" /> {a.metadata.attachments.join(", ")}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </TabsContent>

              <TabsContent value="emails" className="space-y-4">
                {loading ? <Spinner /> : (
                  <>
                    <section>
                      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium"><Reply className="h-4 w-4" /> Replies and bounce notifications</h3>
                      {incoming.length === 0 ? <Empty text="Nothing has come back yet." /> : (
                        <ul className="space-y-2">
                          {incoming.map((m) => (
                            <li key={m.id} className="rounded-md border border-border p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="min-w-0 flex-1 break-words text-sm font-medium">{m.subject || "(no subject)"}</p>
                                <Badge variant={/bounce|rejected|complaint/.test(m.classification) ? "destructive" : "secondary"}>{CLASSIFICATION_LABEL[m.classification] ?? m.classification}</Badge>
                              </div>
                              <p className="break-all text-xs text-muted-foreground">From {m.senderEmail} · {fmt(m.receivedAt)}</p>
                              {m.bounce?.status && <p className="mt-1 text-xs">Status {m.bounce.status}{m.bounce.finalRecipient ? ` for ${m.bounce.finalRecipient}` : ""}</p>}
                              {m.bounce?.diagnostic && <p className="mt-1 break-words text-xs text-muted-foreground">{m.bounce.diagnostic}</p>}
                              {!m.bounce?.diagnostic && m.bodyPreview && <p className="mt-1 break-words text-xs text-muted-foreground">{m.bodyPreview}</p>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                    <section>
                      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium"><Mail className="h-4 w-4" /> Sent emails</h3>
                      {history.length === 0 ? <Empty text="No emails sent yet." /> : (
                        <ul className="space-y-2">
                          {history.map((h) => (
                            <li key={h.id} className="rounded-md border border-border p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="min-w-0 flex-1 break-words text-sm font-medium">{h.subject}</p>
                                <Badge variant={h.dryRun ? "outline" : h.status === "Sent" ? "secondary" : "destructive"}>
                                  {h.dryRun ? "Not delivered (dry run)" : h.status === "Sent" ? "Accepted" : "Failed"}
                                </Badge>
                                {h.outcome && <Badge variant="outline">{h.outcome}</Badge>}
                              </div>
                              <p className="break-all text-xs text-muted-foreground">
                                {fmt(h.sentAt)} · To {h.recipient}
                                {h.senderEmail ? ` · From ${h.senderEmail}` : ""}
                                {h.templateName ? ` · Template: ${h.templateName}` : ""}
                              </p>
                              {h.errorMessage && <p className="mt-1 break-words text-xs text-destructive">{h.errorMessage}</p>}
                              {h.attachments && h.attachments.length > 0 && (
                                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                  <Paperclip className="h-3 w-3 shrink-0" /> Attachments: {h.attachments.map((a) => `${a.fileName}${a.fileSize ? ` (${formatBytes(a.fileSize)})` : ""}`).join(", ")}
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </>
                )}
              </TabsContent>

              <TabsContent value="notes">
                <NotesPanel contactId={contact.id} notes={notes} loading={loading} timezone={timezone} onChange={refresh} />
              </TabsContent>

              <TabsContent value="followups">
                <FollowUpsPanel contactId={contact.id} followUps={followUps} loading={loading} timezone={timezone} onChange={refresh} />
              </TabsContent>
            </Tabs>

            <EmailCorrectionDialog contact={correcting ? contact : null} onClose={() => setCorrecting(false)} onSaved={refresh} />
            <BlockContactDialog contact={blocking ? contact : null} onClose={() => { setBlocking(false); void refresh(); }} />

            <AlertDialog open={!!pendingStatus} onOpenChange={(o) => !o && setPendingStatus(null)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Change status to “{pendingStatus}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This overrides what MailFlow detected and is recorded on the contact's timeline. Marking an address valid lets it be emailed again, so only do this if you're sure.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="status-reason">Reason (optional)</Label>
                  <Input id="status-reason" value={statusReason} onChange={(e) => setStatusReason(e.target.value)} maxLength={500} />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={applyStatus}>Change status</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, hint }: { label: string; value?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value || "—"}</dd>
      {hint && <p className="break-words text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const Spinner = () => <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
const Empty = ({ text }: { text: string }) => <p className="py-4 text-sm text-muted-foreground">{text}</p>;

function NotesPanel({ contactId, notes, loading, timezone, onChange }: { contactId: string; notes: NoteRow[]; loading: boolean; timezone?: string; onChange: () => Promise<void> }) {
  const mergeContact = useApp((s) => s.mergeContact);
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ contact: unknown }>, ok: string) => {
    setBusy(true);
    try {
      mergeContact((await fn()).contact);
      toast.success(ok);
      await onChange();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} placeholder="Add a note…" />
        <Button
          size="sm"
          disabled={busy || !text.trim()}
          onClick={async () => {
            if (await run(() => api.post(`/contacts/${contactId}/notes`, { text }), "Note added")) setText("");
          }}
        >
          Add note
        </Button>
      </div>
      {loading ? <Spinner /> : notes.length === 0 ? <Empty text="No notes yet." /> : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border p-3">
              {editingId === n.id ? (
                <div className="space-y-2">
                  <Textarea rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={5000} />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy || !editText.trim()}
                      onClick={async () => {
                        if (await run(() => api.put(`/contacts/${contactId}/notes/${n.id}`, { text: editText }), "Note updated")) setEditingId(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words text-sm">{n.text}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Last updated: {formatDateTime(n.updatedAt, timezone)}
                      {n.versions?.length > 0 ? ` · created ${formatDateTime(n.createdAt, timezone)}` : ""}
                    </p>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit note" onClick={() => { setEditingId(n.id); setEditText(n.text); }}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label="Delete note" disabled={busy} onClick={() => run(() => api.del(`/contacts/${contactId}/notes/${n.id}`), "Note deleted")}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                  {n.versions?.length > 0 && (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="flex cursor-pointer items-center gap-1"><History className="h-3 w-3" /> {n.versions.length} earlier version{n.versions.length === 1 ? "" : "s"}</summary>
                      <ul className="mt-1 space-y-1">
                        {[...n.versions].reverse().map((v, i) => (
                          <li key={i} className="rounded bg-muted/40 p-2">
                            <p className="whitespace-pre-wrap break-words">{v.text}</p>
                            <p className="mt-0.5 opacity-80">{formatDateTime(v.savedAt, timezone)}</p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const daysFromNow = (n: number) => {
  const d = new Date(Date.now() + n * 86400e3);
  d.setHours(9, 0, 0, 0);
  return d;
};

function FollowUpsPanel({ contactId, followUps, loading, timezone, onChange }: { contactId: string; followUps: FollowUpRow[]; loading: boolean; timezone?: string; onChange: () => Promise<void> }) {
  const mergeContact = useApp((s) => s.mergeContact);
  const [custom, setCustom] = useState(() => toLocalInput(daysFromNow(1)));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ contact: unknown }>, ok: string) => {
    setBusy(true);
    try {
      mergeContact((await fn()).contact);
      toast.success(ok);
      await onChange();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (date: Date) => {
    if (await run(() => api.post(`/contacts/${contactId}/follow-ups`, { dueAt: date.toISOString(), note: note.trim() }), `Follow-up set for ${formatDateTime(date, timezone)}`)) setNote("");
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border border-border p-3">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What to follow up on (optional)" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => add(daysFromNow(1))}>Tomorrow</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => add(daysFromNow(3))}>After 3 days</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => add(daysFromNow(7))}>After 7 days</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="datetime-local" className="w-auto" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              const d = new Date(custom);
              if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) return toast.error("Pick a time in the future");
              void add(d);
            }}
          >
            Set date
          </Button>
        </div>
      </div>
      {loading ? <Spinner /> : followUps.length === 0 ? <Empty text="No follow-ups yet." /> : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {followUps.map((f) => {
            const overdue = f.status === "Pending" && new Date(f.dueAt) < new Date();
            return (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm">
                    {f.status === "Done" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : f.status === "Cancelled" ? <X className="h-3.5 w-3.5 text-muted-foreground" /> : overdue ? <Clock className="h-3.5 w-3.5 text-destructive" /> : <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />}
                    {formatDateTime(f.dueAt, timezone)}
                    {overdue && <Badge variant="destructive">Overdue</Badge>}
                    {f.status !== "Pending" && <Badge variant="outline">{f.status}</Badge>}
                  </p>
                  {f.note && <p className="break-words text-xs text-muted-foreground">{f.note}</p>}
                </div>
                {f.status === "Pending" && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.patch(`/contacts/${contactId}/follow-ups/${f.id}`, { status: "Done" }), "Follow-up completed")}>Done</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api.patch(`/contacts/${contactId}/follow-ups/${f.id}`, { status: "Cancelled" }), "Follow-up cancelled")}>Cancel</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
