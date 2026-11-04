import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { composeEmail, currentDateLabel, useApp } from "@/lib/store";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Send, CalendarClock, Loader2, Ban } from "lucide-react";
import { blockUntilLabel } from "@/lib/block";
import { formatDateTime } from "@/lib/datetime";
import { CampaignTracker } from "@/components/campaign-tracker";
import { ContactProfileSheet } from "@/components/contact-profile-sheet";
import { RecipientSelector } from "@/components/recipient-selector";
import { ResumeAttachmentPicker } from "@/components/resume-attachment-picker";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/compose")({
  head: () => ({ meta: [{ title: "Compose — MailFlow" }] }),
  component: ComposePage,
});

const MAX_PER_SEND = 50;
const MODE_DEFAULT = "__mode_default__";

function ComposePage() {
  const { contacts, templates, contactsLoaded, templatesLoaded, emailAccounts, loadContacts, loadTemplates, loadEmailAccounts, createSchedules, user } = useApp();
  useAuthedLoad(() => Promise.all([loadContacts(), loadTemplates(), loadEmailAccounts()]), [contactsLoaded, templatesLoaded]);

  const [templateId, setTemplateId] = useState<string>("");
  const [mode, setMode] = useState<"now" | "later">("now");
  const [when, setWhen] = useState({ date: format(new Date(), "yyyy-MM-dd"), time: user?.settings.defaultSendTime ?? "09:00" });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [resumeIds, setResumeIds] = useState<string[]>([]);
  const [senderChoice, setSenderChoice] = useState(MODE_DEFAULT);
  const [profileId, setProfileId] = useState<string | null>(null);

  // A send in progress comes back after a refresh: the server knows, not this tab.
  useAuthedLoad(async () => {
    const res = await api.get<{ campaign: { id: string } | null }>("/campaigns/active");
    if (res.campaign) setCampaignId(res.campaign.id);
  });

  useEffect(() => {
    if (!templateId && templates.length) setTemplateId((templates.find((t) => t.favorite) ?? templates[0]).id);
  }, [templates, templateId]);

  const template = templates.find((t) => t.id === templateId);

  // A template's default resume is preselected. Swapping templates swaps that default but keeps
  // anything chosen by hand, and removing it stays removed until the template changes.
  const autoResume = useRef<string | null>(null);
  const defaultApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!template || defaultApplied.current === template.id) return;
    defaultApplied.current = template.id;
    const previous = autoResume.current;
    const next = template.defaultResumeId;
    autoResume.current = next;
    setResumeIds((ids) => {
      const kept = previous ? ids.filter((id) => id !== previous) : ids;
      return next && !kept.includes(next) ? [...kept, next] : kept;
    });
  }, [template]);

  const selectedIds = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
  const blockedContacts = useMemo(() => contacts.filter((c) => c.blocked), [contacts]);

  const accounts = emailAccounts?.accounts ?? [];
  const chosenAccount = senderChoice === MODE_DEFAULT || senderChoice === "system" ? null : accounts.find((a) => a.id === senderChoice);
  // Mirrors how the server picks the sender, so the preview and the label tell the truth.
  const usesCustomDefault = senderChoice === MODE_DEFAULT && emailAccounts?.sendingMode === "custom";
  const effectiveAccount = chosenAccount ?? (usesCustomDefault ? accounts.find((a) => a.isDefault) : undefined);
  const senderEmail = effectiveAccount?.senderEmail ?? emailAccounts?.system.senderEmail ?? "";
  const senderName = effectiveAccount?.senderName || user?.profile.senderName || user?.name || "";
  const modeDefaultLabel =
    emailAccounts?.sendingMode === "custom"
      ? `My default account${accounts.find((a) => a.isDefault) ? ` (${accounts.find((a) => a.isDefault)?.senderEmail})` : " (not set)"}`
      : `System account (${emailAccounts?.system.senderEmail ?? "…"})`;
  const sendChoice = senderChoice === MODE_DEFAULT ? undefined : senderChoice;

  const previewContact = contacts.find((c) => selected[c.id]) ?? contacts.find((c) => !c.blocked);
  const preview = template && previewContact
    ? composeEmail(template, previewContact, {
        senderName,
        senderEmail,
        signature: user?.profile.signature ?? "",
        currentDate: currentDateLabel(user?.settings.timezone),
      })
    : null;

  // One id per attempt: a double click or network retry can't start a second send.
  const requestId = useRef(crypto.randomUUID());

  const doSend = async () => {
    if (!template) return toast.error("Pick a template");
    if (selectedIds.length === 0) return toast.error("Select at least one contact");

    setBusy(true);
    try {
      if (mode === "now") {
        if (selectedIds.length > MAX_PER_SEND) return toast.error(`Send to at most ${MAX_PER_SEND} contacts at a time`);
        const res = await api.post<{ campaign: { id: string } }>("/campaigns", {
          templateId: template.id,
          contactIds: selectedIds,
          resumeIds,
          clientRequestId: requestId.current,
          ...(sendChoice ? { emailAccountId: sendChoice } : {}),
        });
        requestId.current = crypto.randomUUID();
        setCampaignId(res.campaign.id);
        setSelected({});
      } else {
        const at = new Date(`${when.date}T${when.time}`);
        if (Number.isNaN(at.getTime())) return toast.error("Pick a valid date and time");
        if (at.getTime() < Date.now() - 60_000) return toast.error("That time is in the past");
        const res = await createSchedules({ templateId: template.id, contactIds: selectedIds, scheduledAt: at.toISOString(), resumeIds, emailAccountId: sendChoice });
        const notes = [
          ...res.blocked.slice(0, 3).map((b) => `${b.name || b.email}: ${b.message}`),
          res.skipped > res.blocked.length && `${res.skipped - res.blocked.length} already scheduled for that time`,
        ].filter(Boolean);
        toast.success(`Scheduled ${res.scheduled} email(s) for ${format(at, "PPp")}`, {
          description: notes.length ? notes.join("\n") : undefined,
        });
        setSelected({});
      }
    } catch (err) {
      // Already sending (e.g. from another tab): show that send instead of an error.
      const running = err instanceof ApiError && err.status === 409 ? err.details?.find((d) => d.field === "campaignId")?.message : undefined;
      if (running) {
        setCampaignId(running);
        toast.info("A send is already in progress. Showing its progress.");
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="Compose">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          {campaignId && (
            <CampaignTracker
              campaignId={campaignId}
              onDismiss={() => setCampaignId(null)}
              onFinished={() => {
                void loadContacts(true);
              }}
            />
          )}

          <Card>
            <CardHeader><CardTitle className="text-base">Recipients</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <RecipientSelector
                contacts={contacts}
                loaded={contactsLoaded}
                selected={selected}
                onChange={setSelected}
                onOpenContact={setProfileId}
                timezone={user?.settings.timezone}
              />

              {blockedContacts.length > 0 && (
                <details className="rounded-md border border-border">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                    <Ban className="h-4 w-4 text-muted-foreground" />
                    {blockedContacts.length} blocked contact{blockedContacts.length === 1 ? "" : "s"} won't be emailed
                  </summary>
                  <ul className="max-h-56 divide-y divide-border overflow-y-auto border-t border-border">
                    {blockedContacts.map((c) => (
                      <li key={c.id} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{c.name || c.email}</p>
                          <Badge variant="outline" className="shrink-0">{blockUntilLabel(c, user?.settings.timezone)}</Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.email}
                          {c.blockedAt && ` · blocked ${formatDateTime(c.blockedAt, user?.settings.timezone)}`}
                        </p>
                        <p className="text-xs">{c.blockReason ? `Reason: ${c.blockReason}` : <span className="text-muted-foreground">No reason given</span>}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader><CardTitle className="text-base">Template</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue placeholder={templatesLoaded ? "Choose template" : "Loading…"} /></SelectTrigger>
                <SelectContent>
                  {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.templateName}</SelectItem>)}
                </SelectContent>
              </Select>
              {preview && (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">Preview{previewContact ? ` · ${previewContact.name || previewContact.email}` : ""}</p>
                  <p className="text-sm font-medium">{preview.subject}</p>
                  <Textarea readOnly value={preview.body} rows={6} className="bg-background" />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Attach Resume</CardTitle></CardHeader>
            <CardContent>
              <ResumeAttachmentPicker value={resumeIds} onChange={setResumeIds} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Delivery</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Send from</Label>
                <Select value={senderChoice} onValueChange={setSenderChoice}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MODE_DEFAULT}>{modeDefaultLabel}</SelectItem>
                    {emailAccounts?.sendingMode === "custom" && <SelectItem value="system">System account ({emailAccounts.system.senderEmail})</SelectItem>}
                    {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.label ? `${a.label} (${a.senderEmail})` : a.senderEmail}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground"><Link to="/email-accounts" className="underline">Manage email accounts</Link></p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant={mode === "now" ? "default" : "outline"} onClick={() => setMode("now")}>
                  <Send className="mr-2 h-4 w-4" /> Send now
                </Button>
                <Button variant={mode === "later" ? "default" : "outline"} onClick={() => setMode("later")}>
                  <CalendarClock className="mr-2 h-4 w-4" /> Schedule
                </Button>
              </div>
              {mode === "later" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2"><Label>Date</Label><Input type="date" value={when.date} min={format(new Date(), "yyyy-MM-dd")} onChange={(e) => setWhen((w) => ({ ...w, date: e.target.value }))} /></div>
                  <div className="space-y-2"><Label>Time</Label><Input type="time" value={when.time} onChange={(e) => setWhen((w) => ({ ...w, time: e.target.value }))} /></div>
                </div>
              )}
              <Button className="w-full" onClick={doSend} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "now" ? (busy ? "Starting" : "Send") : "Schedule"} {selectedIds.length > 0 && `(${selectedIds.length})`}
              </Button>
              {mode === "now" && (
                <p className="text-xs text-muted-foreground">Emails go out one by one, up to {MAX_PER_SEND} per send, with live progress here.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ContactProfileSheet contactId={profileId} onClose={() => setProfileId(null)} />
    </AppShell>
  );
}
