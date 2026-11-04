import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FieldSuggestions } from "@/components/spelling-suggestions";
import { errorMessage } from "@/lib/api";
import { companyFromEmail, isValidEmail, normalizeEmail, type ImportRow } from "@/lib/contact-data";
import type { ParsedImport } from "@/lib/contact-import";
import type { ImportResult } from "@/lib/store";

const PREVIEW_LIMIT = 300;

type RowStatus = "new" | "invalid" | "duplicate" | "exists";
type DraftRow = ImportRow & { key: number; include: boolean };

const statusLabel: Record<RowStatus, { text: string; variant: "secondary" | "destructive" | "outline" }> = {
  new: { text: "New", variant: "secondary" },
  invalid: { text: "Invalid email", variant: "destructive" },
  duplicate: { text: "Duplicate in file", variant: "outline" },
  exists: { text: "Already a contact", variant: "outline" },
};

const formatLabel: Record<ParsedImport["format"], string> = {
  csv: "CSV",
  excel: "Excel",
  docx: "Word document",
  txt: "text file",
};

interface Summary {
  found: number;
  imported: number;
  duplicates: number;
  invalid: number;
  missingOptional: number;
  companyFromEmail: number;
  excluded: number;
}

export function ContactImportDialog({
  parsed,
  fileName,
  existingEmails,
  onClose,
  onImport,
}: {
  parsed: ParsedImport | null;
  fileName: string;
  existingEmails: Set<string>;
  onClose: () => void;
  onImport: (rows: ImportRow[]) => Promise<ImportResult>;
}) {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [defaultCategory, setDefaultCategory] = useState("Uncategorized");
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    if (!parsed) return;
    setRows(parsed.rows.map((r, i) => ({ ...r, email: normalizeEmail(r.email), key: i, include: true })));
    setSummary(null);
  }, [parsed]);

  // Status is derived from the current values, so applying a suggestion re-validates the row.
  const classified = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((r) => {
      let status: RowStatus = "new";
      if (!isValidEmail(r.email)) status = "invalid";
      else if (seen.has(r.email)) status = "duplicate";
      else if (existingEmails.has(r.email)) status = "exists";
      if (status !== "invalid") seen.add(r.email);
      return { row: r, status, derivedCompany: r.company ? "" : companyFromEmail(r.email) };
    });
  }, [rows, existingEmails]);

  const counts = useMemo(() => {
    const c = { found: classified.length, ready: 0, duplicates: 0, invalid: 0, missingOptional: 0, excluded: 0 };
    for (const { row, status } of classified) {
      if (status === "invalid") c.invalid++;
      else if (status === "duplicate" || status === "exists") c.duplicates++;
      else if (!row.include) c.excluded++;
      else {
        c.ready++;
        if (!row.name || !row.title || !row.company) c.missingOptional++;
      }
    }
    return c;
  }, [classified]);

  const update = (key: number, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const allNewIncluded = classified.filter((c) => c.status === "new").every((c) => c.row.include);
  const toggleAll = (include: boolean) =>
    setRows((prev) => prev.map((r) => ({ ...r, include })));

  const doImport = async () => {
    const toSend = classified
      .filter((c) => c.status === "new" && c.row.include)
      .map(({ row }) => ({
        name: row.name,
        email: row.email,
        title: row.title,
        company: row.company,
        category: row.category || defaultCategory.trim() || "Uncategorized",
        notes: row.notes,
      }));
    if (toSend.length === 0) return toast.error("Nothing to import");
    setImporting(true);
    try {
      const res = await onImport(toSend);
      setSummary({
        found: counts.found,
        imported: res.imported,
        duplicates: counts.duplicates + res.duplicates,
        invalid: counts.invalid + res.invalid,
        missingOptional: res.missingOptional,
        companyFromEmail: res.companyFromEmail,
        excluded: counts.excluded,
      });
      toast.success(`Imported ${res.imported} contact${res.imported === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const visible = classified.slice(0, PREVIEW_LIMIT);

  return (
    <Dialog open={!!parsed} onOpenChange={(o) => !o && !importing && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{summary ? "Import summary" : "Review import"}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" /> {fileName}
            {parsed && <span>· {formatLabel[parsed.format]}</span>}
          </DialogDescription>
        </DialogHeader>

        {summary ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-5 w-5 text-primary" /> Import finished.
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat label="Records found" value={summary.found} />
              <SummaryStat label="Imported" value={summary.imported} strong />
              <SummaryStat label="Duplicates skipped" value={summary.duplicates} />
              <SummaryStat label="Invalid emails" value={summary.invalid} />
              <SummaryStat label="Missing optional fields" value={summary.missingOptional} hint="No name, title or company" />
              <SummaryStat label="Company from email" value={summary.companyFromEmail} />
              <SummaryStat label="Excluded by you" value={summary.excluded} />
            </dl>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {parsed && !parsed.structured && (
              <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  This file isn't a contact table, so these contacts were picked out of the text. Only the email addresses are
                  certain. Check names and companies against the source line before importing, and untick anything that isn't a
                  contact.
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">{counts.found} found</Badge>
                <Badge variant="secondary">{counts.ready} ready to import</Badge>
                {counts.duplicates > 0 && <Badge variant="outline">{counts.duplicates} duplicate</Badge>}
                {counts.invalid > 0 && <Badge variant="destructive">{counts.invalid} invalid</Badge>}
                {counts.missingOptional > 0 && <Badge variant="outline">{counts.missingOptional} missing optional fields</Badge>}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Label htmlFor="default-category" className="whitespace-nowrap text-xs text-muted-foreground">
                  Category if empty
                </Label>
                <Input id="default-category" className="h-8 w-40" value={defaultCategory} onChange={(e) => setDefaultCategory(e.target.value)} />
              </div>
            </div>

            <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={allNewIncluded} onCheckedChange={(v) => toggleAll(!!v)} aria-label="Include all" />
                    </TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No email addresses were found in this file.
                      </TableCell>
                    </TableRow>
                  )}
                  {visible.map(({ row, status, derivedCompany }) => (
                    <TableRow key={row.key} className={status !== "new" ? "opacity-60" : undefined}>
                      <TableCell className="align-top">
                        <Checkbox
                          checked={status === "new" && row.include}
                          disabled={status !== "new"}
                          onCheckedChange={(v) => update(row.key, { include: !!v })}
                          aria-label={`Include ${row.email}`}
                        />
                      </TableCell>
                      <TableCell className="max-w-[260px] align-top">
                        <div className="truncate font-medium" title={row.email}>{row.email || "—"}</div>
                        {row.source && (
                          <div className="truncate text-[11px] text-muted-foreground" title={row.source}>“{row.source}”</div>
                        )}
                        <div className="mt-1">
                          <FieldSuggestions compact value={row.email} kind="email" onApply={(next) => update(row.key, { email: normalizeEmail(next) })} />
                        </div>
                      </TableCell>
                      <TableCell className="align-top">{row.name || <Optional />}</TableCell>
                      <TableCell className="align-top">
                        {row.title || <Optional />}
                        <div className="mt-1">
                          <FieldSuggestions compact value={row.title} kind="company" onApply={(next) => update(row.key, { title: next })} />
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        {row.company ? (
                          row.company
                        ) : derivedCompany ? (
                          <span className="inline-flex items-center gap-1">
                            {derivedCompany}
                            <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">from email</Badge>
                          </span>
                        ) : (
                          <Optional />
                        )}
                        <div className="mt-1">
                          <FieldSuggestions compact value={row.company} kind="company" onApply={(next) => update(row.key, { company: next })} />
                        </div>
                      </TableCell>
                      <TableCell className="align-top">{row.category || <span className="text-muted-foreground">{defaultCategory || "Uncategorized"}</span>}</TableCell>
                      <TableCell className="align-top">
                        <Badge variant={statusLabel[status].variant} className="whitespace-nowrap">{statusLabel[status].text}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {classified.length > PREVIEW_LIMIT && (
              <p className="text-xs text-muted-foreground">
                Showing the first {PREVIEW_LIMIT} of {classified.length} rows. All ticked valid rows will be imported.
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={importing}>Cancel</Button>
              <Button onClick={doImport} disabled={importing || counts.ready === 0}>
                {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {counts.ready} contact{counts.ready === 1 ? "" : "s"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Optional() {
  return <span className="text-xs text-muted-foreground/70">—</span>;
}

function SummaryStat({ label, value, hint, strong }: { label: string; value: number; hint?: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tracking-tight ${strong ? "text-primary" : ""}`}>{value}</dd>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
