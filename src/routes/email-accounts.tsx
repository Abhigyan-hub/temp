import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Inbox, Loader2, Pencil, Plug, Plus, Send, Server, Star, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { GUIDE_LANGUAGES, SMTP_GUIDE, type GuideLanguage } from "@/lib/smtp-guide";
import { useApp, type EmailAccount } from "@/lib/store";

export const Route = createFileRoute("/email-accounts")({
  head: () => ({ meta: [{ title: "Email Accounts — MailFlow" }] }),
  component: EmailAccountsPage,
});

interface MailboxStatus {
  key: string;
  label: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string;
  lastMatched: number;
}

function EmailAccountsPage() {
  const { emailAccounts, loadEmailAccounts, deleteEmailAccount, setDefaultEmailAccount, setSendingMode } = useApp();
  const timezone = useApp((s) => s.user?.settings.timezone);
  useAuthedLoad(() => loadEmailAccounts());

  const [editing, setEditing] = useState<EmailAccount | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<EmailAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      const res = await fn();
      const message = (res as { message?: string } | undefined)?.message ?? ok;
      if (message) toast.success(message);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const info = emailAccounts;
  const custom = info?.sendingMode === "custom";
  const hasDefault = !!info?.accounts.some((a) => a.isDefault);

  return (
    <AppShell
      title="Email Accounts"
      actions={
        <Button size="sm" onClick={() => setCreating(true)} disabled={info ? !info.encryptionConfigured : true}>
          <Plus className="mr-2 h-4 w-4" /> Add account
        </Button>
      }
    >
      {!info ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 space-y-4 lg:col-span-2">
            {!info.encryptionConfigured && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Custom accounts are off: set CREDENTIAL_ENCRYPTION_KEY on the server (see DEPLOYMENT.md). The system account still works.</p>
              </div>
            )}

            <Card>
              <CardHeader><CardTitle className="text-base">Sending mode</CardTitle></CardHeader>
              <CardContent>
                <RadioGroup
                  value={info.sendingMode}
                  onValueChange={(v) => run("mode", () => setSendingMode(v as "system" | "custom"), "Sending mode updated")}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <ModeOption value="system" title="System default" description={`Uses the server's account (${info.system.senderEmail}). Nothing to set up.`} />
                  <ModeOption value="custom" title="My own email account" description="Uses your default account below. If it fails you'll see an error; mail never falls back to the system account." />
                </RadioGroup>
                {custom && !hasDefault && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> Add an account and set it as default, or sending will fail with an error.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0"><CardTitle className="text-base">System account</CardTitle><Badge variant={custom ? "outline" : "secondary"}>{custom ? "Not in use" : "In use"}</Badge></CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <p className="break-all font-medium">{info.system.senderEmail}</p>
                  <p className="text-xs text-muted-foreground">{info.system.host}:{info.system.port} · configured on the server, the password never leaves it</p>
                </div>
                <Button size="sm" variant="outline" disabled={busy === "system"} onClick={() => run("system", () => api.post("/email-accounts/system/test"))}>
                  {busy === "system" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />} Test connection
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">My accounts</CardTitle></CardHeader>
              <CardContent>
                {info.accounts.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <Server className="h-8 w-8 text-muted-foreground/60" />
                    <p className="text-sm text-muted-foreground">No accounts yet. Add one to send from your own address.</p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {info.accounts.map((a) => (
                      <li key={a.id} className="rounded-md border border-border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="min-w-0 flex-1 break-all text-sm font-medium">{a.label ? `${a.label} · ` : ""}{a.senderEmail}</p>
                          {a.isDefault && <Badge variant="secondary"><Star className="mr-1 h-3 w-3" /> Default</Badge>}
                          {a.lastTestOk === true && <Badge variant="outline" className="gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-600" /> Works</Badge>}
                          {a.lastTestOk === false && <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> Failed</Badge>}
                        </div>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {a.smtpHost}:{a.smtpPort} · {a.smtpSecurity === "ssl" ? "SSL/TLS" : "STARTTLS"} · {a.smtpUsername}
                          {a.replyTo ? ` · Reply-To ${a.replyTo}` : ""}
                          {a.imapEnabled ? ` · reads replies via ${a.imapHost}` : ""}
                        </p>
                        {a.lastTestError && <p className="mt-1 text-xs text-destructive">{a.lastTestError}</p>}
                        {a.lastTestAt && <p className="text-[11px] text-muted-foreground">Last tested {formatDateTime(a.lastTestAt, timezone)}</p>}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button size="sm" variant="outline" disabled={busy === `test-${a.id}`} onClick={() => run(`test-${a.id}`, async () => { try { return await api.post(`/email-accounts/${a.id}/test`); } finally { await loadEmailAccounts(true); } })}>
                            {busy === `test-${a.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />} Test connection
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy === `send-${a.id}`} onClick={() => run(`send-${a.id}`, async () => { try { return await api.post(`/email-accounts/${a.id}/test-send`); } finally { await loadEmailAccounts(true); } })}>
                            {busy === `send-${a.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />} Send test email
                          </Button>
                          {!a.isDefault && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(`default-${a.id}`, () => setDefaultEmailAccount(a.id), "Default account updated")}><Star className="mr-1.5 h-3.5 w-3.5" /> Set as default</Button>}
                          <Button size="sm" variant="ghost" onClick={() => setEditing(a)}><Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(a)}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <InboxSyncCard timezone={timezone} />
          </div>

          <div className="min-w-0"><SetupGuide /></div>
        </div>
      )}

      <AccountDialog open={creating || !!editing} account={editing} onClose={() => { setCreating(false); setEditing(null); }} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.senderEmail}?</AlertDialogTitle>
            <AlertDialogDescription>The saved password is erased. Accounts used by scheduled emails can't be deleted until those are sent or cancelled.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const a = deleting;
                setDeleting(null);
                if (a) void run(`delete-${a.id}`, () => deleteEmailAccount(a.id), "Account deleted");
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

function ModeOption({ value, title, description }: { value: string; title: string; description: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

function InboxSyncCard({ timezone }: { timezone?: string }) {
  const [status, setStatus] = useState<{ enabled: boolean; intervalMinutes: number; mailboxes: MailboxStatus[] } | null>(null);
  const [syncing, setSyncing] = useState(false);
  useAuthedLoad(async () => setStatus(await api.get("/incoming/status")));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base"><Inbox className="h-4 w-4" /> Replies and bounces</CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={syncing || !status?.enabled}
          onClick={async () => {
            setSyncing(true);
            try {
              const r = await api.post<{ scanned: number; stored: number; errors: string[]; mailboxes: MailboxStatus[] }>("/incoming/sync");
              setStatus((s) => (s ? { ...s, mailboxes: r.mailboxes } : s));
              if (r.errors.length) toast.error(r.errors[0]);
              else toast.success(`Checked ${r.scanned} new message${r.scanned === 1 ? "" : "s"}, found ${r.stored} related to your emails`);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setSyncing(false);
            }
          }}
        >
          {syncing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Check now
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          {status?.enabled === false
            ? "Inbox checking is turned off on the server."
            : `MailFlow reads the inbox every ${status?.intervalMinutes ?? 5} minutes, read-only: nothing is marked read, moved or deleted. Only replies and bounces for emails you sent here are saved. The rest of the inbox isn't stored.`}
        </p>
        <ul className="divide-y divide-border rounded-md border border-border">
          {status?.mailboxes.map((m) => (
            <li key={m.key} className="px-3 py-2">
              <p className="break-all text-sm">{m.label}</p>
              <p className="text-xs text-muted-foreground">{m.lastSyncAt ? `Last checked ${formatDateTime(m.lastSyncAt, timezone)}` : "Not checked yet"}</p>
              {m.lastError && <p className="break-words text-xs text-destructive">{m.lastError}</p>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const BLANK = {
  label: "",
  senderName: "",
  senderEmail: "",
  replyTo: "",
  smtpHost: "",
  smtpPort: "465",
  smtpSecurity: "ssl" as "ssl" | "starttls",
  smtpUsername: "",
  password: "",
  imapEnabled: false,
  imapHost: "",
};

function AccountDialog({ open, account, onClose }: { open: boolean; account: EmailAccount | null; onClose: () => void }) {
  const saveEmailAccount = useApp((s) => s.saveEmailAccount);
  const [form, setForm] = useState(BLANK);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowPassword(false);
    setForm(
      account
        ? {
            label: account.label,
            senderName: account.senderName,
            senderEmail: account.senderEmail,
            replyTo: account.replyTo,
            smtpHost: account.smtpHost,
            smtpPort: String(account.smtpPort),
            smtpSecurity: account.smtpSecurity,
            smtpUsername: account.smtpUsername,
            password: "",
            imapEnabled: account.imapEnabled,
            imapHost: account.imapHost,
          }
        : BLANK,
    );
  }, [open, account]);

  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const fillGmail = () =>
    setForm((f) => ({ ...f, smtpHost: "smtp.gmail.com", smtpPort: "465", smtpSecurity: "ssl", imapHost: "imap.gmail.com", smtpUsername: f.smtpUsername || f.senderEmail }));

  // Port and security have to agree; keep them matched for the two usual ports.
  const changePort = (value: string) => setForm((f) => ({ ...f, smtpPort: value, smtpSecurity: value === "587" ? "starttls" : value === "465" ? "ssl" : f.smtpSecurity }));
  const changeSecurity = (value: "ssl" | "starttls") => setForm((f) => ({ ...f, smtpSecurity: value, smtpPort: value === "starttls" && f.smtpPort === "465" ? "587" : value === "ssl" && f.smtpPort === "587" ? "465" : f.smtpPort }));

  const movesCredentials = !!account && (form.smtpHost !== account.smtpHost || form.smtpUsername !== account.smtpUsername || (form.imapEnabled && form.imapHost !== account.imapHost));

  const save = async () => {
    setSaving(true);
    try {
      const { password, smtpPort, ...rest } = form;
      await saveEmailAccount(account?.id ?? null, { ...rest, smtpPort: Number(smtpPort), imapPort: 993, ...(password ? { password } : {}) });
      toast.success(account ? "Account updated" : "Account saved. Test the connection next.");
      setForm((f) => ({ ...f, password: "" }));
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? "Edit email account" : "Add email account"}</DialogTitle>
          <DialogDescription>
            Your password is encrypted on the server and never shown again. <button type="button" className="underline" onClick={fillGmail}>Fill in Gmail settings</button>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Account name (optional)" value={form.label} onChange={(v) => set("label", v)} placeholder="Work Gmail" />
          <TextField label="Sender display name" value={form.senderName} onChange={(v) => set("senderName", v)} />
          <TextField label="Sender email address" type="email" value={form.senderEmail} onChange={(v) => set("senderEmail", v)} />
          <TextField label="Reply-To address (optional)" type="email" value={form.replyTo} onChange={(v) => set("replyTo", v)} />
          <TextField label="SMTP host" value={form.smtpHost} onChange={(v) => set("smtpHost", v)} placeholder="smtp.example.com" />
          <div className="grid grid-cols-2 gap-2">
            <TextField label="SMTP port" inputMode="numeric" value={form.smtpPort} onChange={changePort} />
            <div className="space-y-2">
              <Label>Security</Label>
              <Select value={form.smtpSecurity} onValueChange={(v) => changeSecurity(v as "ssl" | "starttls")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ssl">SSL/TLS</SelectItem>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <TextField label="SMTP username" value={form.smtpUsername} onChange={(v) => set("smtpUsername", v)} autoComplete="off" />
          <div className="space-y-2">
            <Label htmlFor="smtp-password">SMTP password or App Password</Label>
            <div className="relative">
              <Input
                id="smtp-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder={account ? "Leave blank to keep the saved one" : ""}
                className="pr-9"
              />
              <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {movesCredentials && !form.password && <p className="text-xs text-destructive">Enter the password again when changing the server or username.</p>}
          </div>
          <div className="space-y-3 rounded-md border border-border p-3 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="imap-enabled">Read replies and bounces from this account</Label>
                <p className="text-xs text-muted-foreground">Read-only IMAP, using the same login.</p>
              </div>
              <Switch id="imap-enabled" checked={form.imapEnabled} onCheckedChange={(v) => set("imapEnabled", v)} />
            </div>
            {form.imapEnabled && <TextField label="IMAP host (port 993)" value={form.imapHost} onChange={(v) => set("imapHost", v)} placeholder="imap.example.com" />}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || (!account && !form.password) || (movesCredentials && !form.password)}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({ label, value, onChange, ...rest }: { label: string; value: string; onChange: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

function SetupGuide() {
  const [language, setLanguage] = useState<GuideLanguage>("en");
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Setup guide</CardTitle>
        <Select value={language} onValueChange={(v) => setLanguage(v as GuideLanguage)}>
          <SelectTrigger className="h-8 w-32" aria-label="Guide language"><SelectValue /></SelectTrigger>
          <SelectContent>
            {GUIDE_LANGUAGES.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-1" lang={language === "hi" ? "hi" : "en"}>
        {SMTP_GUIDE[language].map((section, i) => (
          <details key={section.title} open={i === 0} className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{section.title}</summary>
            <div className="space-y-2 border-t border-border px-3 py-2 text-sm">
              {section.steps && (
                <ol className="list-decimal space-y-1 pl-5">
                  {section.steps.map((s) => <li key={s}>{s}</li>)}
                </ol>
              )}
              {section.body?.map((p) => <p key={p} className="text-muted-foreground">{p}</p>)}
              {section.rows && (
                <dl className="space-y-1.5">
                  {section.rows.map((r) => (
                    <div key={r.label}>
                      <dt className="text-xs font-medium">{r.label}</dt>
                      <dd className="break-words text-muted-foreground">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
