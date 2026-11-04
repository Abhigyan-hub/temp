import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { formatBytes, RESUME_TYPE_LABEL } from "@/lib/files";
import { resumeFileName, useApp, type Resume } from "@/lib/store";

type Preview = { kind: "pdf"; url: string } | { kind: "html"; html: string } | { kind: "none" };

const DOC_STYLES =
  "<style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#222;background:#fff;padding:24px;max-width:780px;margin:auto}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}</style>";

/**
 * Preview fetched through the authenticated API (no storage URLs): PDFs in the browser's viewer,
 * DOCX converted to HTML and shown in a script-less sandboxed frame, .doc offered as a download.
 */
export function ResumePreviewDialog({ resume, onClose }: { resume: Resume | null; onClose: () => void }) {
  const { fetchResumeFile, downloadResume } = useApp();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!resume) return;
    let objectUrl = "";
    let cancelled = false;
    setPreview(null);
    setError("");

    (async () => {
      if (resume.fileType === "doc") return setPreview({ kind: "none" });
      const file = await fetchResumeFile(resume.id);
      if (cancelled) return;
      if (resume.fileType === "pdf") {
        objectUrl = URL.createObjectURL(new Blob([file], { type: "application/pdf" }));
        setPreview({ kind: "pdf", url: objectUrl });
      } else {
        const mammoth = await import("mammoth");
        const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
        if (!cancelled) setPreview({ kind: "html", html: DOC_STYLES + value });
      }
    })().catch((err) => !cancelled && setError(errorMessage(err)));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resume, fetchResumeFile]);

  return (
    <Dialog open={!!resume} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{resume?.name}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2">
            {resume && (
              <>
                <span>{RESUME_TYPE_LABEL[resume.fileType]}</span>·<span>{formatBytes(resume.fileSize)}</span>·
                <span className="truncate">{resume.originalFileName}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7"
                  onClick={() => downloadResume(resume).catch((err) => toast.error(errorMessage(err)))}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" /> {resume && resumeFileName(resume)}
                </Button>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/30">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">{error}</div>
          ) : !preview ? (
            <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : preview.kind === "pdf" ? (
            <iframe title="Resume preview" src={preview.url} className="h-full w-full" />
          ) : preview.kind === "html" ? (
            <iframe title="Resume preview" srcDoc={preview.html} sandbox="" className="h-full w-full bg-white" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <p>Word 97-2003 (.doc) files can't be previewed in the browser.</p>
              <p>Download the file to view it.</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
