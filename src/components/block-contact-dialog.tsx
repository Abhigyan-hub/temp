import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useApp, type Contact } from "@/lib/store";
import {
  BLOCK_DURATIONS,
  blockUntilFrom,
  initialBlockValue,
  QUICK_BLOCK_REASONS,
  type BlockDuration,
  type BlockValue,
} from "@/lib/block";

/** Reason + duration inputs, shared by the Block dialog and the Edit Contact dialog. */
export function BlockFields({ value, onChange, timezone }: { value: BlockValue; onChange: (v: BlockValue) => void; timezone?: string }) {
  const preview = blockUntilFrom(value);
  return (
    <div className="grid gap-3">
      <div className="space-y-2">
        <Label htmlFor="block-reason">Why are you blocking? <span className="font-normal text-muted-foreground">(shown when sending)</span></Label>
        <Textarea
          id="block-reason"
          rows={2}
          maxLength={500}
          value={value.reason}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
          placeholder="e.g. Asked not to be contacted"
        />
        <div className="flex flex-wrap gap-1.5">
          {QUICK_BLOCK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChange({ ...value, reason: r })}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Block for</Label>
          <Select value={value.duration} onValueChange={(d) => onChange({ ...value, duration: d as BlockDuration })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(BLOCK_DURATIONS).map(([k, d]) => <SelectItem key={k} value={k}>{d.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {value.duration === "custom" && (
          <div className="space-y-2">
            <Label htmlFor="block-until">Blocked until</Label>
            <Input id="block-until" type="datetime-local" value={value.customUntil} onChange={(e) => onChange({ ...value, customUntil: e.target.value })} />
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {"error" in preview
          ? preview.error
          : preview.until
            ? `Blocked until ${formatDateTime(preview.until, timezone)}, then unblocked automatically. Scheduled emails before then are cancelled.`
            : "Blocked until you unblock it. All pending scheduled emails to this contact are cancelled."}
      </p>
    </div>
  );
}

/** Block dialog opened from the contact's actions menu. */
export function BlockContactDialog({ contact, onClose }: { contact: Contact | null; onClose: () => void }) {
  const setBlock = useApp((s) => s.setBlock);
  const timezone = useApp((s) => s.user?.settings.timezone);
  const [value, setValue] = useState<BlockValue>(initialBlockValue());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (contact) setValue(initialBlockValue(contact));
  }, [contact]);

  const save = async () => {
    if (!contact) return;
    const until = blockUntilFrom(value);
    if ("error" in until) return toast.error(until.error);
    setSaving(true);
    try {
      await setBlock(contact.id, { blocked: true, reason: value.reason.trim(), until: until.until });
      toast.success(`${contact.name || contact.email} blocked`, {
        description: until.until ? `Until ${formatDateTime(until.until, timezone)}` : "Until you unblock",
      });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!contact} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{contact?.blocked ? "Update block" : "Block contact"}</DialogTitle>
          <DialogDescription className="truncate">{contact ? `${contact.name ? `${contact.name} · ` : ""}${contact.email}` : ""}</DialogDescription>
        </DialogHeader>
        <BlockFields value={value} onChange={setValue} timezone={timezone} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="destructive" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {contact?.blocked ? "Update block" : "Block"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

