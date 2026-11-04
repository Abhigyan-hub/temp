import { useEffect, useMemo, useState } from "react";
import { FileText, Library, Paperclip, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResumeUploadDialog } from "@/components/resume-upload-dialog";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { formatBytes, RESUME_TYPE_LABEL } from "@/lib/files";
import { resumeFileName, useApp } from "@/lib/store";

/** "Attach Resume" for Compose: pick saved resumes or upload new ones; reports selected ids. */
export function ResumeAttachmentPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { resumes, resumesLoaded, resumeStatus, loadResumes, loadResumeStatus } = useApp();
  useAuthedLoad(() => Promise.all([loadResumes(), loadResumeStatus()]), [resumesLoaded]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Drop selections whose resume was deleted from the library meanwhile.
  useEffect(() => {
    if (!resumesLoaded) return;
    const kept = value.filter((id) => resumes.some((r) => r.id === id));
    if (kept.length !== value.length) onChange(kept);
  }, [resumesLoaded, resumes, value, onChange]);

  const maxCount = resumeStatus?.limits.maxAttachments ?? 5;
  const maxBytes = resumeStatus?.limits.maxAttachmentBytes;
  const selected = value.map((id) => resumes.find((r) => r.id === id)).filter((r) => !!r);
  const total = selected.reduce((s, r) => s + r.fileSize, 0);
  const overLimit = !!maxBytes && total > maxBytes;
  const storageMissing = resumeStatus?.storage.configured === false;

  const add = (ids: string[]) => {
    const next = [...new Set([...value, ...ids])];
    if (next.length > maxCount) toast.warning(`Attach at most ${maxCount} resumes`);
    onChange(next.slice(0, maxCount));
  };

  return (
    <div className="space-y-3">
      {selected.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attachments. Every recipient gets the same files you add here.</p>
      ) : (
        <ul className="space-y-1.5">
          {selected.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm" title={resumeFileName(r)}>{resumeFileName(r)}</span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{RESUME_TYPE_LABEL[r.fileType]}</Badge>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(r.fileSize)}</span>
              <button
                type="button"
                aria-label={`Remove ${r.name}`}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((id) => id !== r.id))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected.length > 0 && (
        <p className={`text-xs ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
          {selected.length} file{selected.length === 1 ? "" : "s"} · {formatBytes(total)} total
          {maxBytes ? ` (limit ${formatBytes(maxBytes)})` : ""}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setLibraryOpen(true)} disabled={value.length >= maxCount}>
          <Library className="mr-1.5 h-4 w-4" /> From library
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setUploadOpen(true)} disabled={storageMissing || value.length >= maxCount}>
          <Upload className="mr-1.5 h-4 w-4" /> Upload new
        </Button>
      </div>

      <LibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} selected={value} onConfirm={(ids) => onChange(ids.slice(0, maxCount))} maxCount={maxCount} />
      <ResumeUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} onUploaded={(uploaded) => add(uploaded.map((r) => r.id))} />
    </div>
  );
}

function LibraryDialog({
  open,
  onOpenChange,
  selected,
  onConfirm,
  maxCount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  selected: string[];
  onConfirm: (ids: string[]) => void;
  maxCount: number;
}) {
  const { resumes, resumesLoaded } = useApp();
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setPicked(selected);
      setQuery("");
    }
  }

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => resumes.filter((r) => !q || [r.name, r.category, r.originalFileName, ...r.labels].some((f) => f.toLowerCase().includes(q))),
    [resumes, q],
  );

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      if (!on) return prev.filter((x) => x !== id);
      if (prev.length >= maxCount) {
        toast.warning(`Attach at most ${maxCount} resumes`);
        return prev;
      }
      return [...prev, id];
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach from Resume Library</DialogTitle>
          <DialogDescription>Select up to {maxCount} resumes.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search resumes…" className="pl-9" />
        </div>
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {!resumesLoaded ? (
            <li className="p-4 text-center text-sm text-muted-foreground">Loading…</li>
          ) : visible.length === 0 ? (
            <li className="p-4 text-center text-sm text-muted-foreground">
              {resumes.length === 0 ? "Your library is empty. Use “Upload new” to add a resume." : "No resumes match."}
            </li>
          ) : (
            visible.map((r) => (
              <li key={r.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                  <Checkbox checked={picked.includes(r.id)} onCheckedChange={(v) => toggle(r.id, !!v)} />
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[r.category, RESUME_TYPE_LABEL[r.fileType], formatBytes(r.fileSize)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              onConfirm(picked);
              onOpenChange(false);
            }}
          >
            Attach {picked.length > 0 ? picked.length : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
