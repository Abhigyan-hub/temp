import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useApp, type EmailSchedule, type ScheduleStatus } from "@/lib/store";
import { errorMessage } from "@/lib/api";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Plus, Send, Trash2, Clock, Loader2, RefreshCw, Paperclip } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/schedule")({
  head: () => ({ meta: [{ title: "Schedule — MailFlow" }] }),
  component: SchedulePage,
});

const localDay = (iso: string) => format(new Date(iso), "yyyy-MM-dd");
const toIso = (date: string, time: string) => new Date(`${date}T${time}`).toISOString();

const statusVariant: Record<ScheduleStatus, "default" | "secondary" | "destructive" | "outline"> = {
  Pending: "default",
  Processing: "default",
  Sent: "secondary",
  Failed: "destructive",
  Cancelled: "outline",
};

function SchedulePage() {
  const { schedules, schedulesLoaded, loadSchedules, sendTestEmail, user } = useApp();
  useAuthedLoad(() => loadSchedules(), [schedulesLoaded]);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"All" | ScheduleStatus>("All");
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Pending schedules are delivered by the server; poll so the page reflects new statuses.
  const hasPending = schedules.some((s) => s.status === "Pending" || s.status === "Processing");
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => loadSchedules(true).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [hasPending, loadSchedules]);

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const tomorrowStr = format(new Date(Date.now() + 86400000), "yyyy-MM-dd");

  const q = search.toLowerCase();
  const filteredSchedules = schedules
    .filter((s) => {
      const matchesSearch =
        !q ||
        s.contact?.name.toLowerCase().includes(q) ||
        s.contact?.email.toLowerCase().includes(q) ||
        s.template?.name.toLowerCase().includes(q) ||
        s.comments?.toLowerCase().includes(q);
      const matchesStatus = filterStatus === "All" || s.status === filterStatus;
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  const group = (predicate: (d: string) => boolean) =>
    filteredSchedules.filter((s) => predicate(localDay(s.scheduledAt)) && s.status === "Pending");

  const todays = group((d) => d <= todayStr);
  const tomorrows = group((d) => d === tomorrowStr);
  const upcoming = group((d) => d > tomorrowStr);

  const handleTestSend = async () => {
    setTesting(true);
    try {
      toast.success(await sendTestEmail());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await loadSchedules(true).catch((err) => toast.error(errorMessage(err)));
    setRefreshing(false);
  };

  return (
    <AppShell title="Schedule">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-4 mb-6">
        <Input
          placeholder="Search contacts, templates or comments..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as typeof filterStatus)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All Status</SelectItem>
            <SelectItem value="Pending">Pending</SelectItem>
            <SelectItem value="Processing">Processing</SelectItem>
            <SelectItem value="Sent">Sent</SelectItem>
            <SelectItem value="Failed">Failed</SelectItem>
            <SelectItem value="Cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>

        <Button onClick={handleTestSend} variant="outline" className="gap-2" disabled={testing} title={user ? `Sends a test email to ${user.email}` : undefined}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Test My Email
        </Button>

        <Button onClick={refresh} variant="ghost" size="icon" aria-label="Refresh" disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>

        <NewScheduleButton />
      </div>

      {!schedulesLoaded ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <ScheduleColumn title="Today" empty="No sends scheduled today." items={todays} />
            <ScheduleColumn title="Tomorrow" empty="Nothing tomorrow yet." items={tomorrows} />
            <ScheduleColumn title="Upcoming" empty="No upcoming sends." items={upcoming} />
          </div>

          {/* Full List */}
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>All Schedules</CardTitle>
            </CardHeader>
            <CardContent>
              <ScheduleList items={filteredSchedules} />
            </CardContent>
          </Card>

          {/* Weekly Calendar Grid */}
          <WeeklyGrid schedules={schedules} />
        </>
      )}
    </AppShell>
  );
}

function ScheduleColumn({ title, empty, items }: { title: string; empty: string; items: EmailSchedule[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-3">
            {items.map((s) => (
              <ScheduleItem key={s.id} schedule={s} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleItem({ schedule }: { schedule: EmailSchedule }) {
  const { updateSchedule, cancelSchedule, sendScheduleNow, deleteSchedule } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDate, setNewDate] = useState(localDay(schedule.scheduledAt));
  const [newTime, setNewTime] = useState(format(new Date(schedule.scheduledAt), "HH:mm"));
  const [comments, setComments] = useState(schedule.comments || "");
  const pending = schedule.status === "Pending";

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleReschedule = async () => {
    const at = new Date(`${newDate}T${newTime}`);
    if (at.getTime() < Date.now() - 60_000) return toast.error("That time is in the past");
    const ok = await act("reschedule", () => updateSchedule(schedule.id, { scheduledAt: toIso(newDate, newTime), comments }), "Rescheduled");
    if (ok) setOpen(false);
  };

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-medium">{schedule.contact?.name || schedule.contact?.email || "Deleted contact"}</p>
        <Badge variant={statusVariant[schedule.status]}>{schedule.status}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {format(new Date(schedule.scheduledAt), "PP 'at' p")}
        {schedule.template && ` · ${schedule.template.name}`}
      </p>
      {schedule.attachments?.length > 0 && (
        <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
          <Paperclip className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Attachments:{" "}
            {schedule.attachments.map((a, i) => (
              <span key={a.resumeId} className={a.missing ? "text-destructive line-through" : undefined} title={a.missing ? "Deleted from the Resume Library" : undefined}>
                {i > 0 && ", "}
                {a.fileName}
              </span>
            ))}
          </span>
        </p>
      )}
      {schedule.comments && <p className="mt-2 text-xs text-muted-foreground">{schedule.comments}</p>}
      {schedule.errorMessage && schedule.status !== "Sent" && (
        <p className={`mt-2 text-xs ${schedule.status === "Failed" ? "text-destructive" : "text-muted-foreground"}`}>{schedule.errorMessage}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {pending && (
          <>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1">
                  <Clock className="h-3 w-3" /> Reschedule
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Reschedule Email</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Date</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-start">
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {format(new Date(`${newDate}T00:00`), "PPP")}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent>
                        <Calendar
                          mode="single"
                          selected={new Date(`${newDate}T00:00`)}
                          disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                          onSelect={(d) => d && setNewDate(format(d, "yyyy-MM-dd"))}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>

                  <div>
                    <Label>Time</Label>
                    <Input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
                  </div>

                  <div>
                    <Label>Comments</Label>
                    <Input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Add note..." />
                  </div>

                  <Button onClick={handleReschedule} className="w-full" disabled={busy === "reschedule"}>
                    {busy === "reschedule" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Reschedule
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act("cancel", () => cancelSchedule(schedule.id), "Schedule cancelled")}>
              Cancel
            </Button>

            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act("send", () => sendScheduleNow(schedule.id), "Send attempted, see status")}>
              {busy === "send" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Send Now
            </Button>
          </>
        )}

        {schedule.status !== "Processing" && (
          <Button variant="destructive" size="sm" aria-label="Delete schedule" disabled={!!busy} onClick={() => act("delete", () => deleteSchedule(schedule.id), "Schedule deleted")}>
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </li>
  );
}

function NewScheduleButton() {
  const { contacts, templates, contactsLoaded, templatesLoaded, loadContacts, loadTemplates, createSchedules, user } = useApp();
  const [open, setOpen] = useState(false);
  useAuthedLoad(() => (open ? Promise.all([loadContacts(), loadTemplates()]) : Promise.resolve()), [open, contactsLoaded, templatesLoaded]);

  const [contactId, setContactId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [time, setTime] = useState(user?.settings.defaultSendTime ?? "09:00");
  const [comments, setComments] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!contactId) return toast.error("Select a contact");
    if (!templateId) return toast.error("Select a template");
    const at = new Date(`${date}T${time}`);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000) return toast.error("Pick a time in the future");
    setSaving(true);
    try {
      const res = await createSchedules({ templateId, contactIds: [contactId], scheduledAt: at.toISOString(), comments });
      if (res.scheduled) {
        toast.success(`Scheduled for ${format(at, "PPp")}`);
        setOpen(false);
        setContactId("");
        setComments("");
      } else {
        toast.error("This email is already scheduled for that time");
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> New Schedule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Scheduled Email</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger>
              <SelectValue placeholder="Select Contact" />
            </SelectTrigger>
            <SelectContent>
              {contacts.filter((c) => !c.blocked).map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name || c.email} - {c.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger>
              <SelectValue placeholder="Select Template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.templateName}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={date} min={format(new Date(), "yyyy-MM-dd")} onChange={(e) => setDate(e.target.value)} />
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <Input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Comments (optional)" />

          <Button onClick={handleAdd} className="w-full" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Schedule Email
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleList({ items }: { items: EmailSchedule[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No schedules found.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((schedule) => (
        <ScheduleItem key={schedule.id} schedule={schedule} />
      ))}
    </ul>
  );
}

function WeeklyGrid({ schedules }: { schedules: EmailSchedule[] }) {
  return (
    <Card className="mt-6">
      <CardHeader><CardTitle className="text-base">This Week</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const key = format(d, "yyyy-MM-dd");
            const count = schedules.filter((s) => s.status === "Pending" && localDay(s.scheduledAt) === key).length;
            return (
              <div key={key} className="rounded-lg border border-border p-3 text-center">
                <div className="text-xs text-muted-foreground">{d.toLocaleDateString(undefined, { weekday: "short" })}</div>
                <div className="mt-1 text-2xl font-semibold tracking-tight">{d.getDate()}</div>
                <div className="mt-2 text-xs text-muted-foreground">{count} email{count === 1 ? "" : "s"}</div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
