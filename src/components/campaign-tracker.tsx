import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Clock, Loader2, Minus, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api, apiUrl, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useApp } from "@/lib/store";

export interface CampaignView {
  id: string;
  campaignName: string;
  status: "Queued" | "Running" | "Completed" | "Cancelled" | "Failed";
  statusMessage: string;
  totalRecipients: number;
  processedCount: number;
  acceptedCount: number;
  failedCount: number;
  skippedCount: number;
  remaining: number;
  senderEmail: string;
  dryRun: boolean;
  cancelRequested: boolean;
}

export interface RecipientView {
  id: string;
  position: number;
  recipientEmail: string;
  recipientName: string;
  company: string;
  status: "Waiting" | "Sending" | "Accepted" | "Failed" | "Skipped" | "Cancelled";
  errorMessage: string;
  retryable: boolean;
  outcome: string;
  sentAt: string | null;
}

const isTerminal = (s: CampaignView["status"]) => s === "Completed" || s === "Cancelled" || s === "Failed";

function AcceptedTick() {
  return (
    <svg viewBox="0 0 24 24" className="mf-tick h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

const STATUS_LABEL: Record<RecipientView["status"], string> = {
  Waiting: "Waiting",
  Sending: "Sending…",
  Accepted: "Sent (accepted)",
  Failed: "Failed",
  Skipped: "Skipped",
  Cancelled: "Cancelled",
};

function StatusIcon({ status }: { status: RecipientView["status"] }) {
  switch (status) {
    case "Accepted":
      return <AcceptedTick />;
    case "Sending":
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
    case "Failed":
      return <X className="h-4 w-4 shrink-0 text-destructive" strokeWidth={3} />;
    case "Skipped":
      return <Ban className="h-4 w-4 shrink-0 text-muted-foreground" />;
    case "Cancelled":
      return <Minus className="h-4 w-4 shrink-0 text-muted-foreground" />;
    default:
      return <Clock className="h-4 w-4 shrink-0 text-muted-foreground/70" />;
  }
}

type Filter = "all" | "active" | "Accepted" | "Failed" | "Skipped";

/**
 * Live panel for one campaign. Progress is read from the server (SSE, with polling as a fallback),
 * so a refresh or lost connection only pauses the display, never the sending.
 */
export function CampaignTracker({ campaignId, onDismiss, onFinished }: { campaignId: string; onDismiss: () => void; onFinished?: () => void }) {
  const timezone = useApp((s) => s.user?.settings.timezone);
  const [campaign, setCampaign] = useState<CampaignView | null>(null);
  const [recipients, setRecipients] = useState<Map<string, RecipientView>>(() => new Map());
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0); // bumped by Retry to reconnect
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const apply = (data: { campaign?: CampaignView; recipients?: RecipientView[] }, replace = false) => {
      if (data.campaign) setCampaign(data.campaign);
      if (data.recipients) {
        setRecipients((prev) => {
          const next = replace ? new Map<string, RecipientView>() : new Map(prev);
          for (const r of data.recipients ?? []) next.set(r.id, r);
          return next;
        });
      }
      if (data.campaign && isTerminal(data.campaign.status)) stop(true);
    };

    let finished = false;
    const stop = (done: boolean) => {
      source?.close();
      source = null;
      if (poll) clearInterval(poll);
      poll = null;
      if (done && !finished) {
        finished = true;
        finishedRef.current?.();
      }
    };

    const startPolling = () => {
      if (poll || closed) return;
      const tick = () =>
        api
          .get<{ campaign: CampaignView; recipients: RecipientView[] }>(`/campaigns/${campaignId}/progress`)
          .then((d) => !closed && apply(d, true))
          .catch(() => {});
      void tick();
      poll = setInterval(tick, 2000);
    };

    source = new EventSource(apiUrl(`/campaigns/${campaignId}/events`), { withCredentials: true });
    source.addEventListener("snapshot", (e) => apply(JSON.parse((e as MessageEvent).data), true));
    source.addEventListener("progress", (e) => apply(JSON.parse((e as MessageEvent).data)));
    source.addEventListener("done", (e) => apply(JSON.parse((e as MessageEvent).data)));
    // Proxies and sleeping laptops drop streams. Everything is in MongoDB, so polling picks it up.
    source.onerror = () => {
      source?.close();
      source = null;
      startPolling();
    };

    return () => {
      closed = true;
      stop(false);
    };
  }, [campaignId, generation]);

  const rows = useMemo(() => [...recipients.values()].sort((a, b) => a.position - b.position), [recipients]);
  const visible = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "active") return r.status === "Waiting" || r.status === "Sending";
    return r.status === filter;
  });

  if (!campaign) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></CardContent>
      </Card>
    );
  }

  const done = isTerminal(campaign.status);
  const percent = campaign.totalRecipients ? Math.round((campaign.processedCount / campaign.totalRecipients) * 100) : 0;
  const retryableCount = rows.filter((r) => r.retryable && (r.status === "Failed" || r.status === "Skipped")).length;

  const retry = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ retried: number; campaign: CampaignView; recipients: RecipientView[] }>(`/campaigns/${campaign.id}/retry`);
      setCampaign(res.campaign);
      setRecipients(new Map(res.recipients.map((r) => [r.id, r])));
      setGeneration((g) => g + 1);
      toast.success(`Retrying ${res.retried} email${res.retried === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ campaign: CampaignView }>(`/campaigns/${campaign.id}/cancel`);
      setCampaign(res.campaign);
      toast.success("Stopping after the current email");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = !done
    ? campaign.cancelRequested
      ? "Stopping…"
      : "Sending campaign…"
    : campaign.status === "Cancelled"
      ? "Campaign cancelled"
      : campaign.status === "Failed"
        ? "Campaign stopped"
        : "Campaign finished";

  const chips: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: rows.length },
    { key: "active", label: "In progress", count: rows.filter((r) => r.status === "Waiting" || r.status === "Sending").length },
    { key: "Accepted", label: "Sent", count: campaign.acceptedCount },
    { key: "Failed", label: "Failed", count: campaign.failedCount },
    { key: "Skipped", label: "Skipped", count: campaign.skippedCount },
  ];

  return (
    <Card aria-live="polite">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {!done && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            {title}
          </CardTitle>
          <p className="truncate text-xs text-muted-foreground">{campaign.campaignName}{campaign.senderEmail ? ` · from ${campaign.senderEmail}` : ""}</p>
        </div>
        <div className="flex gap-2">
          {!done && !campaign.cancelRequested && <Button size="sm" variant="outline" disabled={busy} onClick={cancel}>Stop</Button>}
          {done && retryableCount > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={retry}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry {retryableCount} failed
            </Button>
          )}
          {done && <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {campaign.dryRun && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Dry run: the backend is running with EMAIL_TRANSPORT=json, so these emails are built but not delivered.
          </p>
        )}
        {campaign.statusMessage && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{campaign.statusMessage}</p>}

        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Progress: {campaign.processedCount} / {campaign.totalRecipients}</span>
            <span className="text-xs text-muted-foreground">{percent}%</span>
          </div>
          <Progress value={percent} />
        </div>

        <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <Count label="Sent" value={campaign.acceptedCount} />
          <Count label="Remaining" value={campaign.remaining} />
          <Count label="Failed" value={campaign.failedCount} />
          <Count label="Skipped" value={campaign.skippedCount} />
        </dl>
        <p className="text-xs text-muted-foreground">
          “Sent” means the mail server accepted the email. It isn't proof of inbox delivery; bounces and replies appear later on each contact.
          {!done && " You can leave this page: sending continues on the server."}
        </p>

        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${filter === c.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {c.label} ({c.count})
            </button>
          ))}
        </div>

        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {visible.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">Nothing here.</li>}
          {visible.map((r) => (
            <li key={r.id} className="flex items-start gap-2.5 px-3 py-2">
              <span className="mt-0.5"><StatusIcon status={r.status} /></span>
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm">{r.recipientEmail}</p>
                {(r.recipientName || r.company) && <p className="truncate text-xs text-muted-foreground">{[r.recipientName, r.company].filter(Boolean).join(" · ")}</p>}
                {r.errorMessage && <p className={`break-words text-xs ${r.status === "Failed" ? "text-destructive" : "text-muted-foreground"}`}>{r.errorMessage}</p>}
                {r.sentAt && r.status === "Accepted" && <p className="text-[11px] text-muted-foreground">{formatDateTime(r.sentAt, timezone)}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-xs text-muted-foreground">{STATUS_LABEL[r.status]}</span>
                {r.outcome && <Badge variant="outline" className="text-[10px]">{r.outcome}</Badge>}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
