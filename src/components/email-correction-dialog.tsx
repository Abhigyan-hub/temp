import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldSuggestions } from "@/components/spelling-suggestions";
import { api, errorMessage } from "@/lib/api";
import { useApp, type Contact } from "@/lib/store";

interface CheckResult {
  email: string;
  valid: boolean;
  duplicate: { id: string; name: string; email: string } | null;
  domain: "ok" | "not-found" | "no-mail-server" | "unknown";
}

const DOMAIN_NOTE: Record<CheckResult["domain"], string> = {
  ok: "The domain has a mail server.",
  "not-found": "This domain doesn't seem to exist.",
  "no-mail-server": "This domain has no mail server.",
  unknown: "Couldn't check the domain right now.",
};

/** Change an address on the user's explicit say-so: validate, check duplicates, confirm, save. */
export function EmailCorrectionDialog({ contact, onClose, onSaved }: { contact: Contact | null; onClose: () => void; onSaved?: () => void }) {
  const mergeContact = useApp((s) => s.mergeContact);
  const [email, setEmail] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);

  useEffect(() => {
    if (contact) {
      setEmail(contact.email);
      setCheck(null);
      setConfirmed(false);
    }
  }, [contact]);

  const change = (value: string) => {
    setEmail(value);
    setCheck(null);
    setConfirmed(false);
  };

  const validate = async () => {
    if (!contact) return;
    setBusy("check");
    try {
      setCheck(await api.get<CheckResult>("/contacts/check-email", { email, excludeId: contact.id }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!contact || !check) return;
    setBusy("save");
    try {
      const res = await api.patch<{ contact: unknown }>(`/contacts/${contact.id}/email`, { email: check.email, confirm: true });
      mergeContact(res.contact);
      toast.success("Email address updated");
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const same = !!contact && check?.email === contact.email;
  const canSave = !!check && check.valid && !check.duplicate && !same && confirmed;

  return (
    <Dialog open={!!contact} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit email address</DialogTitle>
          <DialogDescription className="break-all">Current: {contact?.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="correct-email">New email address</Label>
            <div className="flex gap-2">
              <Input id="correct-email" type="email" value={email} onChange={(e) => change(e.target.value)} />
              <Button type="button" variant="outline" onClick={validate} disabled={!email.trim() || busy === "check"}>
                {busy === "check" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Validate
              </Button>
            </div>
            <FieldSuggestions value={email} kind="email" onApply={change} />
          </div>

          {check && (
            <ul className="space-y-1 rounded-md border border-border p-3 text-sm">
              <CheckRow ok={check.valid} text={check.valid ? "Valid email format" : "This isn't a valid email address"} />
              {check.valid && (
                <CheckRow
                  ok={!check.duplicate}
                  text={check.duplicate ? `Already used by ${check.duplicate.name || check.duplicate.email}` : "Not used by another contact"}
                />
              )}
              {check.valid && <CheckRow ok={check.domain === "ok"} warn={check.domain === "unknown"} text={DOMAIN_NOTE[check.domain]} />}
              {same && <CheckRow ok={false} warn text="This is the current address" />}
            </ul>
          )}

          {check?.valid && !check.duplicate && !same && (
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(!!v)} className="mt-0.5" />
              <span>
                Change this contact to <span className="font-medium break-all">{check.email}</span>. The old address stays in the history, and the bounce status starts over.
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!busy}>Cancel</Button>
          <Button onClick={save} disabled={!canSave || !!busy}>
            {busy === "save" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckRow({ ok, warn, text }: { ok: boolean; warn?: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      ) : warn ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <span>{text}</span>
    </li>
  );
}
