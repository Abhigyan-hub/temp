import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Send, Clock, ShieldAlert, AlertTriangle, TrendingUp, History, Paperclip } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — MailFlow" }] }),
  component: DashboardPage,
});

function StatCard({ label, value, icon: Icon, hint }: { label: string; value: number | string; icon: React.ComponentType<{ className?: string }>; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
          <div className="rounded-lg bg-accent/15 p-2.5 text-accent-foreground">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardPage() {
  const { contacts, contactsLoaded, stats, loadStats, loadContacts } = useApp();
  useAuthedLoad(() => Promise.all([loadStats(), loadContacts()]), [contactsLoaded]);

  // Daily counts arrive keyed by date in the account's timezone; fill in empty days.
  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = format(d, "yyyy-MM-dd");
    const row = stats?.daily.find((x) => x.date === key);
    return { day: d.toLocaleDateString(undefined, { weekday: "short" }), count: row?.sent ?? 0, failed: row?.failed ?? 0 };
  });

  const catData = stats?.categories ?? [];
  const catColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

  const suggestions = contacts.filter((c) => !c.blocked && c.status === "Pending").slice(0, 5);
  const v = (n: number | undefined) => (stats ? (n ?? 0) : "—");

  return (
    <AppShell title="Dashboard" actions={<Button asChild size="sm"><Link to="/compose">New campaign</Link></Button>}>
      {stats?.emailMode === "dry-run" && (
        <div className="mb-4 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Emails are not being delivered.</p>
            <p className="text-xs">The backend is running in dry-run mode (EMAIL_TRANSPORT=json). Restart it with EMAIL_TRANSPORT=smtp to send real email.</p>
          </div>
        </div>
      )}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total contacts" value={v(stats?.totalContacts)} icon={Users} hint={stats ? `${stats.notContacted} not contacted yet` : undefined} />
        <StatCard label="Emails sent" value={v(stats?.sent)} icon={Send} hint={stats && stats.totalEmails ? `${stats.successRate}% success rate` : undefined} />
        <StatCard label="Scheduled" value={v(stats?.pendingSchedules)} icon={Clock} hint="Waiting to send" />
        <StatCard label="Blocked" value={v(stats?.blockedContacts)} icon={ShieldAlert} />
        <StatCard label="Failed" value={v(stats?.failed)} icon={AlertTriangle} hint={stats ? `${stats.sentLast24h}/${stats.dailyLimit} sent in 24h` : undefined} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Daily sends (last 7 days)</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--muted-foreground)" fontSize={12} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }} />
                <Bar dataKey="count" name="Sent" fill="var(--primary)" radius={[6, 6, 0, 0]} />
                <Bar dataKey="failed" name="Failed" fill="var(--destructive)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By category</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {catData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No contacts yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" outerRadius={80} innerRadius={45} paddingAngle={2}>
                    {catData.map((_, i) => (<Cell key={i} fill={catColors[i % catColors.length]} />))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Suggested emails today</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Pending, non-blocked contacts.</p>
            </div>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">You're all caught up.</p>
            ) : (
              <ul className="divide-y divide-border">
                {suggestions.map((c) => (
                  <li key={c.id} className="flex items-center justify-between py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <Badge variant="secondary">{c.category}</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{c.title} · {c.company}</p>
                    </div>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/compose">Send</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Recent activity</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Latest delivery attempts.</p>
            </div>
            <History className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!stats || stats.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No emails sent yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {stats.recent.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{h.subject}</p>
                      <p className="truncate text-xs text-muted-foreground" title={h.errorMessage || undefined}>
                        {h.recipient} · {formatDistanceToNow(new Date(h.sentAt), { addSuffix: true })}
                        {h.status === "Failed" && h.errorMessage ? ` · ${h.errorMessage}` : ""}
                      </p>
                      {h.attachments && h.attachments.length > 0 && (
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" title={h.attachments.map((a) => a.fileName).join(", ")}>
                          <Paperclip className="h-3 w-3 shrink-0" /> Attachments: {h.attachments.map((a) => a.fileName).join(", ")}
                        </p>
                      )}
                    </div>
                    {h.dryRun ? (
                      <Badge variant="outline" title="Built in dry-run mode; never delivered">Not delivered</Badge>
                    ) : (
                      <Badge variant={h.status === "Sent" ? "secondary" : "destructive"}>{h.status}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}