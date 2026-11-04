import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { browserTimezone, useApp } from "@/lib/store";
import { api, errorMessage } from "@/lib/api";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/lib/theme";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — MailFlow" }] }),
  component: SettingsPage,
});

const timezones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

function SettingsPage() {
  const { user, updateSettings } = useApp();
  const { theme, toggle } = useTheme();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [signature, setSignature] = useState("");
  const [timezone, setTimezone] = useState("");
  const [defaultSendTime, setDefaultSendTime] = useState("09:00");
  const [saving, setSaving] = useState<"profile" | "sending" | null>(null);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setEmail(user.email);
    setSenderName(user.profile.senderName);
    setSignature(user.profile.signature);
    setTimezone(user.settings.timezone);
    setDefaultSendTime(user.settings.defaultSendTime);
  }, [user]);

  const save = async (section: "profile" | "sending", patch: Parameters<typeof updateSettings>[0]) => {
    setSaving(section);
    try {
      await updateSettings(patch);
      toast.success("Settings saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <AppShell title="Settings">
      <div className="grid gap-4 md:grid-cols-2 max-w-4xl">
        <Card>
          <CardHeader><CardTitle className="text-base">Profile</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-2"><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <Button
              disabled={saving === "profile"}
              onClick={() => {
                if (!name.trim() || !email.trim()) return toast.error("Name and email are required");
                save("profile", { name: name.trim(), email: email.trim() });
              }}
            >
              {saving === "profile" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Theme</p>
                <p className="text-xs text-muted-foreground">Current: {theme}</p>
              </div>
              <Button variant="outline" onClick={toggle}>Toggle {theme === "light" ? "dark" : "light"}</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sending</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label>Sender name</Label>
              <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder={name} />
              <p className="text-xs text-muted-foreground">Shown as the "From" name on every email.</p>
            </div>
            <div className="space-y-2">
              <Label>Signature</Label>
              <Textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Appended to the end of every email (optional)" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Timezone</Label>
                {timezones.length ? (
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                ) : (
                  <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                )}
              </div>
              <div className="space-y-2">
                <Label>Default send time</Label>
                <Input type="time" value={defaultSendTime} onChange={(e) => setDefaultSendTime(e.target.value)} />
              </div>
            </div>
            {timezone && timezone !== browserTimezone() && (
              <p className="text-xs text-muted-foreground">
                Your browser is on {browserTimezone()}. Times you pick are always in your browser's local time.
              </p>
            )}
            <Button
              disabled={saving === "sending"}
              onClick={() => save("sending", { profile: { senderName, signature }, settings: { timezone, defaultSendTime } })}
            >
              {saving === "sending" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
            </Button>
          </CardContent>
        </Card>

        <ChangePasswordCard />
      </div>
    </AppShell>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) return toast.error("New password must be at least 8 characters");
    if (newPassword !== confirm) return toast.error("Passwords don't match");
    setSaving(true);
    try {
      await api.put("/auth/password", { currentPassword, newPassword });
      toast.success("Password changed. Other sessions were signed out.");
      setCurrent("");
      setNew("");
      setConfirm("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Password</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-2"><Label>Current password</Label><Input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></div>
          <div className="space-y-2"><Label>New password</Label><Input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></div>
          <div className="space-y-2"><Label>Confirm new password</Label><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
          <Button type="submit" disabled={saving || !currentPassword}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
