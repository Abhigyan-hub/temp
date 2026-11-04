import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, FileUp, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { errorMessage } from "@/lib/api";
import { formatBytes, RESUME_ACCEPT, resumeFileProblem } from "@/lib/files";
import { useApp, type Resume, type ResumeUploadResult } from "@/lib/store";

const NO_CATEGORY = "__none__";
const NEW_CATEGORY = "__new__";

/** Upload one or more resumes. Used by the Resume Library and by Compose ("Upload new resume"). */
export function ResumeUploadDialog({
  open,
  onOpenChange,
  onUploaded,
  defaultCategory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: (resumes: Resume[]) => void;
  defaultCategory?: string;
}) {
  const { resumeCategories, resumeCategoriesLoaded, resumeStatus, loadResumeCategories, loadResumeStatus, uploadResumes } = useApp();
  useAuthedLoad(() => (open ? Promise.all([loadResumeCategories(), loadResumeStatus()]) : Promise.resolve()), [open, resumeCategoriesLoaded]);

  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState(NO_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [description, setDescription] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ResumeUploadResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setCategory(defaultCategory || NO_CATEGORY);
    setNewCategory("");
    setDescription("");
    setProgress(null);
    setResult(null);
  }, [open, defaultCategory]);

  const maxBytes = resumeStatus?.limits.maxFileBytes;
  const maxFiles = resumeStatus?.limits.maxFilesPerUpload ?? 10;
  const storageReady = resumeStatus?.storage.configured !== false;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(list)) {
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      if (next.length > maxFiles) toast.warning(`Upload at most ${maxFiles} files at a time`);
      return next.slice(0, maxFiles);
    });
  };

  const problems = files.map((f) => resumeFileProblem(f, maxBytes));
  const valid = files.filter((_, i) => !problems[i]);
  const uploading = progress !== null && !result;

  const upload = async () => {
    if (valid.length === 0) return toast.error("Choose at least one PDF or Word file");
    const chosenCategory = category === NEW_CATEGORY ? newCategory.trim() : category === NO_CATEGORY ? "" : category;
    if (category === NEW_CATEGORY && !chosenCategory) return toast.error("Enter a name for the new category");
    setProgress(0);
    try {
      const res = await uploadResumes(valid, { category: chosenCategory, description: description.trim() }, setProgress);
      setResult(res);
      if (res.uploaded.length) {
        toast.success(`Uploaded ${res.uploaded.length} resume${res.uploaded.length === 1 ? "" : "s"}`);
        onUploaded?.(res.uploaded);
      } else toast.warning("No new resumes were uploaded");
    } catch (err) {
      toast.error(errorMessage(err));
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !uploading && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{result ? "Upload complete" : "Upload resumes"}</DialogTitle>
          <DialogDescription>
            PDF or Word (.docx, .doc){maxBytes ? `, up to ${formatBytes(maxBytes)} each` : ""}. Files are stored privately.
          </DialogDescription>
        </DialogHeader>

        {!storageReady && (
          <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {resumeStatus?.storage.reason}
          </div>
        )}

        {result ? (
          <div className="space-y-3 text-sm">
            {result.uploaded.map((r) => (
              <ResultRow key={r.id} icon={<CheckCircle2 className="h-4 w-4 text-primary" />} name={r.originalFileName} note="Uploaded" />
            ))}
            {result.duplicates.map((d, i) => (
              <ResultRow
                key={`d${i}`}
                icon={<Copy className="h-4 w-4 text-muted-foreground" />}
                name={d.fileName}
                note={d.existing ? `Already in your library as "${d.existing.name}"` : "Already in your library"}
              />
            ))}
            {result.rejected.map((r, i) => (
              <ResultRow key={`r${i}`} icon={<AlertTriangle className="h-4 w-4 text-destructive" />} name={r.fileName} note={r.reason} />
            ))}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              disabled={uploading}
              className={`flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-sm transition-colors ${
                dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
              }`}
            >
              <FileUp className="h-6 w-6 text-muted-foreground" />
              <span className="font-medium">Drop files here or click to choose</span>
              <span className="text-xs text-muted-foreground">You can select several files at once</span>
            </button>
            <input
              ref={input}
              type="file"
              multiple
              accept={RESUME_ACCEPT}
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {files.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {files.map((f, i) => (
                  <li key={`${f.name}-${f.size}`} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                    <span className={`shrink-0 text-xs ${problems[i] ? "text-destructive" : "text-muted-foreground"}`}>
                      {problems[i] ?? formatBytes(f.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      disabled={uploading}
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={category} onValueChange={setCategory} disabled={uploading}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                    {resumeCategories.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
                    <SelectItem value={NEW_CATEGORY}>+ New category…</SelectItem>
                  </SelectContent>
                </Select>
                {category === NEW_CATEGORY && (
                  <Input autoFocus value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="e.g. Backend Developer" maxLength={80} />
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="resume-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input id="resume-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} disabled={uploading} />
              </div>
            </div>

            {uploading && (
              <div className="space-y-1">
                <Progress value={Math.round((progress ?? 0) * 100)} />
                <p className="text-xs text-muted-foreground">
                  {progress !== null && progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Checking and saving files…"}
                </p>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>Cancel</Button>
              <Button onClick={upload} disabled={uploading || valid.length === 0 || !storageReady}>
                {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Upload {valid.length > 0 ? valid.length : ""} file{valid.length === 1 ? "" : "s"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResultRow({ icon, name, note }: { icon: React.ReactNode; name: string; note: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0">
        <p className="truncate font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}
