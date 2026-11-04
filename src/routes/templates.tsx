import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { composeEmail, currentDateLabel, insertAtCursor, renderTemplate, resumeFileName, useApp, type Template, type TemplateInput } from "@/lib/store";
import { CONTACT_VARIABLES, SENDER_VARIABLES } from "@shared/templateRender.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/api";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, Star, MoreHorizontal, Eye, Copy, Pencil, Trash2, Search, Loader2, Braces, Paperclip } from "lucide-react";

import { toast } from "sonner";

const NO_RESUME = "__none__";

export const Route = createFileRoute("/templates")({
  head: () => ({ meta: [{ title: "Templates — MailFlow" }] }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const { templates, templatesLoaded, contacts, contactsLoaded, loadTemplates, loadContacts, addTemplate, updateTemplate, deleteTemplate, duplicateTemplate, toggleFavorite } = useApp();
  useAuthedLoad(() => Promise.all([loadTemplates(), loadContacts()]), [templatesLoaded, contactsLoaded]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<Template | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  const categories = useMemo(() => Array.from(new Set(templates.map((t) => t.category))), [templates]);
  const q = query.trim().toLowerCase();
  const visible = (filter === "all" ? templates : filter === "favorites" ? templates.filter((t) => t.favorite) : templates.filter((t) => t.category === filter))
    .filter((t) => !q || [t.templateName, t.subject, t.body].some((f) => f.toLowerCase().includes(q)));
  const sampleContact = contacts[0];
  const user = useApp((s) => s.user);
  const previewSender = {
    senderName: user?.profile.senderName || user?.name || "",
    senderEmail: user?.email ?? "",
    signature: user?.profile.signature ?? "",
    currentDate: currentDateLabel(user?.settings.timezone),
  };

  const run = (p: Promise<unknown>, success: string) =>
    p.then(() => toast.success(success)).catch((err) => toast.error(errorMessage(err)));

  return (
    <AppShell title="Templates" actions={<Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" /> New template</Button>}>
      <div className="relative mb-3 max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates…" className="pl-9" />
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <FilterChip label="All" active={filter === "all"} onClick={() => setFilter("all")} />
        <FilterChip label="⭐ Favorites" active={filter === "favorites"} onClick={() => setFilter("favorites")} />
        {categories.map((c) => (<FilterChip key={c} label={c} active={filter === c} onClick={() => setFilter(c)} />))}
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {!templatesLoaded ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : templates.length === 0 ? "No templates yet. Create your first one." : "No templates match."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((t) => (
            <Card key={t.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base truncate">{t.templateName}</CardTitle>
                    <div className="mt-1"><Badge variant="secondary">{t.category}</Badge></div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => toggleFavorite(t.id).catch((err) => toast.error(errorMessage(err)))}className="text-muted-foreground hover:text-foreground" aria-label="Favorite">
                      <Star className={`h-4 w-4 ${t.favorite ? "fill-current text-amber-500" : ""}`} />
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setPreview(t)}><Eye className="mr-2 h-4 w-4" /> Preview</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditing(t)}><Pencil className="mr-2 h-4 w-4" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => run(duplicateTemplate(t.id), "Duplicated")}>
                          <Copy className="mr-2 h-4 w-4" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={() => run(deleteTemplate(t.id), "Deleted")}>
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm font-medium">{t.subject}</p>
                <p className="mt-2 line-clamp-4 whitespace-pre-line text-sm text-muted-foreground">{t.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <TemplateDialog
        open={creating || !!editing}
        template={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSave={async (data) => {
          try {
            if (editing) { await updateTemplate(editing.id, data); toast.success("Template updated"); }
            else { await addTemplate(data); toast.success("Template created"); }
            setCreating(false);
            setEditing(null);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{preview?.templateName}</DialogTitle>
            <DialogDescription>Preview {sampleContact ? `for ${sampleContact.name}` : "with variables"}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3">
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Subject</div>
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                  {sampleContact ? renderTemplate(preview.subject, sampleContact, previewSender) : preview.subject}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Body</div>
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-sans">
                  {sampleContact ? composeEmail(preview, sampleContact, previewSender).body : preview.body}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
}

function TemplateDialog({
  open,
  template,
  onClose,
  onSave,
}: {
  open: boolean;
  template: Template | null;
  onClose: () => void;
  onSave: (data: TemplateInput) => Promise<void>;
}) {
  const { contacts, resumes, user, emailAccounts, loadResumes, loadContacts, loadEmailAccounts } = useApp();
  useAuthedLoad(() => (open ? Promise.all([loadResumes(), loadContacts(), loadEmailAccounts()]) : Promise.resolve()), [open]);

  const [saving, setSaving] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [category, setCategory] = useState("Hiring");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [defaultResumeId, setDefaultResumeId] = useState(NO_RESUME);
  const [previewContactId, setPreviewContactId] = useState("");

  useEffect(() => {
    if (open) {
      setTemplateName(template?.templateName ?? "");
      setCategory(template?.category ?? "Hiring");
      setSubject(template?.subject ?? "");
      setBody(template?.body ?? "");
      setDefaultResumeId(template?.defaultResumeId ?? NO_RESUME);
    }
  }, [open, template]);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // The variable goes wherever the user was last typing.
  const lastField = useRef<"subject" | "body">("body");

  const insertVariable = (variable: string) => {
    const isSubject = lastField.current === "subject";
    const el = isSubject ? subjectRef.current : bodyRef.current;
    const current = isSubject ? subject : body;
    const { value, cursor } = insertAtCursor(current, el?.selectionStart, el?.selectionEnd, `{{${variable}}}`);
    if (isSubject) setSubject(value);
    else setBody(value);
    // After the menu closes and React renders, put the cursor right after the variable.
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const sampleContact = contacts.find((c) => c.id === previewContactId) ?? contacts.find((c) => !c.blocked) ?? null;
  const account = emailAccounts?.sendingMode === "custom" ? emailAccounts.accounts.find((a) => a.isDefault) : undefined;
  // Rendered from the current text on each keystroke; nothing here touches the saved template.
  const rendered = composeEmail({ subject, body }, sampleContact, {
    senderName: account?.senderName || user?.profile.senderName || user?.name || "",
    senderEmail: account?.senderEmail ?? emailAccounts?.system.senderEmail ?? "",
    signature: user?.profile.signature ?? "",
    currentDate: currentDateLabel(user?.settings.timezone),
  });
  const attachedResume = resumes.find((r) => r.id === defaultResumeId);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            Personalize with variables. Add a fallback for empty values with {"{{name|there}}"}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="grid content-start gap-3 min-w-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Template name</Label><Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} /></div>
              <div className="space-y-2"><Label>Category</Label><Input value={category} onChange={(e) => setCategory(e.target.value)} /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-subject">Subject</Label>
              <Input id="template-subject" ref={subjectRef} value={subject} onFocus={() => (lastField.current = "subject")} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="template-body">Body</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="h-7"><Braces className="mr-1.5 h-3.5 w-3.5" /> Insert Variable</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                    <DropdownMenuLabel className="text-xs">Contact</DropdownMenuLabel>
                    {CONTACT_VARIABLES.map((v) => <DropdownMenuItem key={v} onSelect={() => insertVariable(v)}>{`{{${v}}}`}</DropdownMenuItem>)}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs">Sender</DropdownMenuLabel>
                    {SENDER_VARIABLES.map((v) => <DropdownMenuItem key={v} onSelect={() => insertVariable(v)}>{`{{${v}}}`}</DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Textarea id="template-body" ref={bodyRef} rows={10} value={body} onFocus={() => (lastField.current = "body")} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Default Resume Attachment <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Select value={defaultResumeId} onValueChange={setDefaultResumeId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_RESUME}>No default resume</SelectItem>
                  {resumes.map((r) => <SelectItem key={r.id} value={r.id}>{resumeFileName(r)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Preselected in Compose. You can remove or replace it before sending.</p>
            </div>
          </div>

          <div className="min-w-0 space-y-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Live preview</p>
              <Select value={sampleContact?.id ?? ""} onValueChange={setPreviewContactId}>
                <SelectTrigger className="h-8 w-56 text-xs"><SelectValue placeholder="No contacts yet" /></SelectTrigger>
                <SelectContent>
                  {contacts.slice(0, 100).map((c) => <SelectItem key={c.id} value={c.id}>{c.name ? `${c.name}${c.company ? ` · ${c.company}` : ""}` : c.email}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Subject</div>
              <div className="min-h-9 break-words rounded-md border border-border bg-background px-3 py-2 text-sm font-medium">{rendered.subject || <span className="font-normal text-muted-foreground">Empty</span>}</div>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Body</div>
              <pre className="min-h-40 whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-sans text-sm">{rendered.body || <span className="text-muted-foreground">Empty</span>}</pre>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Paperclip className="h-3 w-3 shrink-0" /> Attachments: {attachedResume ? resumeFileName(attachedResume) : "None"}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={async () => {
            if (!templateName.trim() || !subject.trim() || !body.trim()) return toast.error("Fill all fields");
            setSaving(true);
            await onSave({ templateName, category, subject, body, defaultResumeId: defaultResumeId === NO_RESUME ? null : defaultResumeId });
            setSaving(false);
          }}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}