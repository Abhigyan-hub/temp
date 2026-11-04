import { useEffect, useState } from "react";
import { AlertTriangle, BellRing, Ban, CalendarClock, Loader2, MailCheck, MailX, Reply, Send, ShieldCheck, Users, XCircle, type LucideIcon } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useApp } from "@/lib/store";
import { CONTACT_INTEL_STATUSES } from "@shared/contactStatus.js";

interface Analytics {
  totalContacts: number;
  validContacts: number;
  invalidContacts: number;
  hardBounced: number;
  softBounced: number;
  blocked: number;
  replied: number;
  awaitingReply: number;
  pendingFollowUps: number;
  overdueFollowUps: number;
  totalEmailsSent: number;
  acceptedEmails: number;
  failedEmails: number;
  averagePerContact: number;
  statusDistribution: { name: string; value: number }[];
  emailsOverTime: { date: string; accepted: number; failed: number }[];
  incomingOverTime: { date: string; bounces: number; replies: number; autoReplies: number }[];
  bounceStats: { name: string; value: number }[];
  replyStats: { name: string; value: number }[];
  filters: { categories: string[]; companies: string[] };
}

interface UpcomingFollowUp {
  id: string;
  dueAt: string;
  note: string;
  contactId: string;
  contact: { id: string; name: string; email: string; company: string };
}

const ALL = "all";
const tooltipStyle = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--popover-foreground)" };
const axis = { stroke: "var(--muted-foreground)", fontSize: 12 };

/** Contacts dashboard. Every number comes from a MongoDB aggregation on the server. */
export function ContactsAnalytics({ onOpenContact }: { onOpenContact: (id: string) => void }) {
  const timezone = useApp((s) => s.user?.settings.timezone);
  const [data, setData] = useState<Analytics | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingFollowUp[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState(ALL);
  const [company, setCompany] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [loading, setLoading] = useState(true);

  const contacts = useApp((s) => s.contacts);

  const load = async () => {
    setLoading(true);
    try {
      const [{ analytics }, f] = await Promise.all([
        api.get<{ analytics: Analytics }>("/contacts/analytics", {
          from: from ? new Date(`${from}T00:00`).toISOString() : undefined,
          to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
          category: category === ALL ? undefined : category,
          company: company === ALL ? undefined : company,
          status: status === ALL ? undefined : status,
        }),
        api.get<{ followUps: UpcomingFollowUp[] }>("/contacts/follow-ups/upcoming"),
      ]);
      setData(analytics);
      setUpcoming(f.followUps);
    } finally {
      setLoading(false);
    }
  };
  useAuthedLoad(load, [from, to, category, company, status]);

  // Status and follow-up changes made in the profile panel show up here.
  const [lastContacts, setLastContacts] = useState(contacts);
  useEffect(() => {
    if (contacts !== lastContacts) {
      setLastContacts(contacts);
      void load().catch((err) => toast.error(errorMessage(err)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]);

  const filtersActive = from || to || category !== ALL || company !== ALL || status !== ALL;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" className="h-9 w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" className="h-9 w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
        <Filter label="Category" value={category} onChange={setCategory} options={data?.filters.categories ?? []} allLabel="All categories" />
        <Filter label="Company" value={company} onChange={setCompany} options={data?.filters.companies ?? []} allLabel="All companies" />
        <Filter label="Status" value={status} onChange={setStatus} options={CONTACT_INTEL_STATUSES} allLabel="All statuses" />
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); setCategory(ALL); setCompany(ALL); setStatus(ALL); }}>Clear filters</Button>
        )}
        {loading && <Loader2 className="mb-2 h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {!data ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Total contacts" value={data.totalContacts} icon={Users} />
            <Tile label="Valid" value={data.validContacts} icon={ShieldCheck} hint="Confirmed by a reply or by you" />
            <Tile label="Invalid" value={data.invalidContacts} icon={XCircle} />
            <Tile label="Hard bounced" value={data.hardBounced} icon={MailX} />
            <Tile label="Soft bounced" value={data.softBounced} icon={AlertTriangle} />
            <Tile label="Blocked" value={data.blocked} icon={Ban} />
            <Tile label="Replied" value={data.replied} icon={Reply} />
            <Tile label="Awaiting reply" value={data.awaitingReply} icon={BellRing} />
            <Tile label="Pending follow-ups" value={data.pendingFollowUps} icon={CalendarClock} hint={data.overdueFollowUps ? `${data.overdueFollowUps} overdue` : undefined} />
            <Tile label="Emails sent" value={data.totalEmailsSent} icon={Send} hint="All send attempts" />
            <Tile label="Failed sends" value={data.failedEmails} icon={MailCheck} />
            <Tile label="Avg per contact" value={data.averagePerContact} icon={Users} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard title="Emails sent over time" subtitle="Accepted by the mail server vs failed. Accepted isn't confirmed delivery." className="lg:col-span-2" empty={data.emailsOverTime.length === 0}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.emailsOverTime}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" {...axis} />
                  <YAxis allowDecimals={false} {...axis} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                  <Legend />
                  <Bar dataKey="accepted" name="Accepted" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar dataKey="failed" name="Failed" fill="var(--chart-4)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Contact status" empty={data.statusDistribution.length === 0}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.statusDistribution} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="name" width={124} interval={0} {...axis} fontSize={11} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                  <Bar dataKey="value" name="Contacts" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Successful vs failed sends" empty={data.totalEmailsSent === 0} valueList={[{ name: "Accepted", value: data.acceptedEmails }, { name: "Failed", value: data.failedEmails }]}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[{ name: "Accepted", value: data.acceptedEmails }, { name: "Failed", value: data.failedEmails }]} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="name" width={72} {...axis} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                  <Bar dataKey="value" name="Emails" radius={[0, 4, 4, 0]} maxBarSize={28}>
                    <Cell fill="var(--chart-1)" />
                    <Cell fill="var(--chart-4)" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Bounce statistics" subtitle="From bounce notifications found in the inbox." empty={data.bounceStats.every((b) => b.value === 0)} valueList={data.bounceStats}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.bounceStats} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="name" width={120} {...axis} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                  <Bar dataKey="value" name="Notifications" fill="var(--chart-3)" radius={[0, 4, 4, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Reply statistics" subtitle="Only real replies count as replied." empty={data.replyStats.every((b) => b.value === 0)} valueList={data.replyStats}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.replyStats} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="name" width={96} {...axis} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                  <Bar dataKey="value" name="Messages" fill="var(--chart-2)" radius={[0, 4, 4, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Upcoming follow-ups</CardTitle></CardHeader>
            <CardContent>
              {upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">No follow-ups scheduled. Add one from a contact's profile.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {upcoming.map((f) => {
                    const overdue = new Date(f.dueAt) < new Date();
                    return (
                      <li key={f.id}>
                        <button className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left hover:bg-muted/40" onClick={() => onOpenContact(f.contactId)}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{f.contact.name || f.contact.email}{f.contact.company ? ` · ${f.contact.company}` : ""}</span>
                            {f.note && <span className="block truncate text-xs text-muted-foreground">{f.note}</span>}
                          </span>
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            {overdue && <Badge variant="destructive">Overdue</Badge>}
                            {formatDateTime(f.dueAt, timezone)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Filter({ label, value, onChange, options, allLabel }: { label: string; value: string; onChange: (v: string) => void; options: readonly string[]; allLabel: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function Tile({ label, value, icon: Icon, hint }: { label: string; value: number; icon: LucideIcon; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, subtitle, className, empty, valueList, children }: { title: string; subtitle?: string; className?: string; empty: boolean; valueList?: { name: string; value: number }[]; children: React.ReactNode }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent>
        <div className="h-56">
          {empty ? <p className="text-sm text-muted-foreground">No data for these filters yet.</p> : children}
        </div>
        {!empty && valueList && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {valueList.map((v) => <li key={v.name}>{v.name}: <span className="font-medium text-foreground">{v.value}</span></li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
