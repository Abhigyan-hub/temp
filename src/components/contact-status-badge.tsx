import { CheckCircle2, CircleHelp, Mail, MailWarning, Reply, ShieldAlert, XCircle, Clock, Bot, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Contact } from "@/lib/store";

const STYLES: Record<Contact["contactStatus"], { className: string; icon: typeof Mail }> = {
  Valid: { className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", icon: CheckCircle2 },
  Unknown: { className: "bg-muted text-muted-foreground", icon: CircleHelp },
  Invalid: { className: "bg-destructive/15 text-destructive", icon: XCircle },
  Bounced: { className: "bg-orange-500/15 text-orange-700 dark:text-orange-300", icon: MailWarning },
  "Soft Bounced": { className: "bg-amber-500/15 text-amber-700 dark:text-amber-300", icon: MailWarning },
  "Hard Bounced": { className: "bg-destructive/15 text-destructive", icon: XCircle },
  "Temporarily Rejected": { className: "bg-amber-500/15 text-amber-700 dark:text-amber-300", icon: Clock },
  Blocked: { className: "bg-foreground/10 text-foreground/70", icon: ShieldAlert },
  Replied: { className: "bg-primary/15 text-primary", icon: Reply },
  "Auto Replied": { className: "bg-sky-500/15 text-sky-700 dark:text-sky-300", icon: Bot },
  Unsubscribed: { className: "bg-foreground/10 text-foreground/70", icon: BellOff },
};

/** Icon plus label, so a status is never told by color alone. */
export function ContactStatusBadge({ status, className }: { status: Contact["contactStatus"] | undefined; className?: string }) {
  const s = STYLES[status ?? "Unknown"] ?? STYLES.Unknown;
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium", s.className, className)}>
      <Icon className="h-3 w-3 shrink-0" />
      {status ?? "Unknown"}
    </span>
  );
}
