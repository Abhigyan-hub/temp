import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Eye, FileText, FolderCog, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { ResumePreviewDialog } from "@/components/resume-preview-dialog";
import { ResumeUploadDialog } from "@/components/resume-upload-dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedLoad } from "@/hooks/use-authed-load";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { formatBytes, RESUME_TYPE_LABEL } from "@/lib/files";
import { useApp, type Resume, type ResumeFileType } from "@/lib/store";

export const Route = createFileRoute("/resumes")({
  head: () => ({ meta: [{ title: "Resume Library — MailFlow" }] }),
  component: ResumesPage,
});

const ALL = "all";
const NO_CATEGORY = "__none__";

function ResumesPage() {
  const {
    resumes,
    resumesLoaded,
    resumeCategories,
    resumeCategoriesLoaded,
    resumeStatus,
    loadResumes,
    loadResumeCategories,
    loadResumeStatus,
    deleteResume,
    downloadResume,
  } = useApp();
  const timezone = useApp((s) => s.user?.settings.timezone);
  useAuthedLoad(() => Promise.all([loadResumes(), loadResumeCategories(), loadResumeStatus()]), [resumesLoaded, resumeCategoriesLoaded]);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [fileType, setFileType] = useState<ResumeFileType | typeof ALL>(ALL);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [preview, setPreview] = useState<Resume | null>(null);
  const [editing, setEditing] = useState<Resume | null>(null);
  const [deleting, setDeleting] = useState<Resume | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return resumes.filter((r) => {
      if (category === NO_CATEGORY ? r.category : category !== ALL && r.category !== category) return false;
      if (fileType !== ALL && r.fileType !== fileType) return false;
      if (!q) return true;
      return [r.name, r.originalFileName, r.description, r.category, ...r.labels].some((f) => f.toLowerCase().includes(q));
    });
  }, [resumes, query, category, fileType]);

  const totalSize = resumes.reduce((s, r) => s + r.fileSize, 0);
  const storageMissing = resumeStatus?.storage.configured === false;

  return (
    <AppShell
      title="Resume Library"
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => setCategoriesOpen(true)}>
            <FolderCog className="h-4 w-4 sm:mr-2" /> <span className="hidden sm:inline">Categories</span>
          </Button>
          <Button size="sm" onClick={() => setUploadOpen(true)} disabled={storageMissing}>
            <Upload className="mr-2 h-4 w-4" /> Upload Resume
          </Button>
        </>
      }
    >
      {storageMissing && (
        <div className="mb-4 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Resume storage isn't set up on the server.</p>
            <p className="text-xs">{resumeStatus?.storage.reason}</p>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, description, labels…" className="pl-9" />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full md:w-56"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All categories</SelectItem>
                <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                {resumeCategories.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={fileType} onValueChange={(v) => setFileType(v as typeof fileType)}>
              <SelectTrigger className="w-full md:w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All formats</SelectItem>
                <SelectItem value="pdf">PDF</SelectItem>
                <SelectItem value="docx">DOCX</SelectItem>
                <SelectItem value="doc">DOC</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {resumesLoaded && resumes.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {resumes.length} resume{resumes.length === 1 ? "" : "s"} · {formatBytes(totalSize)}
              {resumeStatus && ` · limit ${resumeStatus.limits.maxResumes}`}
            </p>
          )}

          <div className="mt-3 overflow-x-auto">
            {!resumesLoaded ? (
              <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : resumes.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <FileText className="h-10 w-10 text-muted-foreground/60" />
                <div>
                  <p className="font-medium">No resumes yet</p>
                  <p className="text-sm text-muted-foreground">Upload PDF or Word resumes to attach them to your emails.</p>
                </div>
                <Button size="sm" onClick={() => setUploadOpen(true)} disabled={storageMissing}>
                  <Upload className="mr-2 h-4 w-4" /> Upload Resume
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">No resumes match these filters.</TableCell>
                    </TableRow>
                  )}
                  {visible.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-[320px]">
                        <button className="block max-w-full truncate text-left font-medium hover:underline" onClick={() => setPreview(r)}>
                          {r.name}
                        </button>
                        <div className="truncate text-xs text-muted-foreground" title={r.originalFileName}>{r.originalFileName}</div>
                        {r.description && <div className="truncate text-xs text-muted-foreground/80" title={r.description}>{r.description}</div>}
                        {r.labels.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.labels.map((l) => <Badge key={l} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{l}</Badge>)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{r.category ? <Badge variant="outline">{r.category}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                      <TableCell><Badge variant="secondary">{RESUME_TYPE_LABEL[r.fileType]}</Badge></TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatBytes(r.fileSize)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.uploadedAt, timezone)}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${r.name}`}><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setPreview(r)}><Eye className="mr-2 h-4 w-4" /> Preview</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditing(r)}><Pencil className="mr-2 h-4 w-4" /> Rename / edit</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => downloadResume(r).catch((err) => toast.error(errorMessage(err)))}>
                              <Download className="mr-2 h-4 w-4" /> Download
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive" onClick={() => setDeleting(r)}>
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <ResumeUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} defaultCategory={category !== ALL && category !== NO_CATEGORY ? category : undefined} />
      <ResumePreviewDialog resume={preview} onClose={() => setPreview(null)} />
      <EditResumeDialog resume={editing} onClose={() => setEditing(null)} />
      <CategoriesDialog open={categoriesOpen} onOpenChange={setCategoriesOpen} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from storage permanently. Emails already sent keep a record of the attachment name. Resumes attached to
              scheduled emails can't be deleted until those are sent or cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const r = deleting;
                setDeleting(null);
                if (r) deleteResume(r.id).then(() => toast.success("Resume deleted")).catch((err) => toast.error(errorMessage(err)));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

function EditResumeDialog({ resume, onClose }: { resume: Resume | null; onClose: () => void }) {
  const { resumeCategories, updateResume } = useApp();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(NO_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [labels, setLabels] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!resume) return;
    setName(resume.name);
    setDescription(resume.description);
    setCategory(resume.category || NO_CATEGORY);
    setNewCategory("");
    setLabels(resume.labels.join(", "));
  }, [resume]);

  const save = async () => {
    if (!resume) return;
    if (!name.trim()) return toast.error("Name is required");
    const chosen = category === "__new__" ? newCategory.trim() : category === NO_CATEGORY ? "" : category;
    if (category === "__new__" && !chosen) return toast.error("Enter a name for the new category");
    setSaving(true);
    try {
      await updateResume(resume.id, {
        name: name.trim(),
        description: description.trim(),
        category: chosen,
        labels: labels.split(",").map((l) => l.trim()).filter(Boolean),
      });
      toast.success("Resume updated");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!resume} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit resume</DialogTitle>
          <DialogDescription>The name is also used as the attachment file name.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-2">
            <Label htmlFor="resume-name">Name</Label>
            <Input id="resume-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                {resumeCategories.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
                <SelectItem value="__new__">+ New category…</SelectItem>
              </SelectContent>
            </Select>
            {category === "__new__" && <Input autoFocus value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="Category name" maxLength={80} />}
          </div>
          <div className="space-y-2">
            <Label htmlFor="resume-desc">Description</Label>
            <Textarea id="resume-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="resume-labels">Labels</Label>
            <Input id="resume-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Comma separated, e.g. react, 2026" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoriesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { resumeCategories, createResumeCategory, renameResumeCategory, deleteResumeCategory } = useApp();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resume categories</DialogTitle>
          <DialogDescription>Rename or delete categories, or add your own. Deleting a category keeps its resumes.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            if (await run(() => createResumeCategory(newName.trim()), "Category added")) setNewName("");
          }}
        >
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New category name" maxLength={80} />
          <Button type="submit" disabled={busy || !newName.trim()}><Plus className="mr-1 h-4 w-4" /> Add</Button>
        </form>
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {resumeCategories.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No categories yet.</li>}
          {resumeCategories.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-2">
              {editingId === c.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (editName.trim() && (await run(() => renameResumeCategory(c.id, editName.trim()), "Category renamed"))) setEditingId(null);
                  }}
                >
                  <Input autoFocus className="h-8" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={80} />
                  <Button type="submit" size="sm" disabled={busy}>Save</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.resumeCount}</span>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Rename ${c.name}`} onClick={() => { setEditingId(c.id); setEditName(c.name); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label={`Delete ${c.name}`} disabled={busy} onClick={() => run(() => deleteResumeCategory(c.id), "Category deleted")}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
