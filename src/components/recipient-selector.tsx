import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ContactStatusBadge } from "@/components/contact-status-badge";
import { formatDateTime } from "@/lib/datetime";
import type { Contact } from "@/lib/store";
import { sendRestriction } from "../../backend/src/shared/contactStatus.js";

const PAGE_SIZE = 25;
const ALL = "all";

const time = (iso?: string | null) => (iso ? new Date(iso).getTime() : 0);
const byText = (a: string, b: string) => {
  // Blank values sort last either way.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
};

const SORTS: Record<string, { label: string; compare: (a: Contact, b: Contact) => number }> = {
  "name-asc": { label: "Name A–Z", compare: (a, b) => byText(a.name, b.name) },
  "name-desc": { label: "Name Z–A", compare: (a, b) => byText(b.name, a.name) },
  "company-asc": { label: "Company A–Z", compare: (a, b) => byText(a.company, b.company) },
  recent: { label: "Recently added", compare: (a, b) => time(b.createdAt) - time(a.createdAt) },
  oldest: { label: "Oldest added", compare: (a, b) => time(a.createdAt) - time(b.createdAt) },
  "last-sent": { label: "Last email sent", compare: (a, b) => time(b.lastEmailedAt) - time(a.lastEmailedAt) },
  "most-sent": { label: "Most emails sent", compare: (a, b) => (b.totalEmailsSent ?? 0) - (a.totalEmailsSent ?? 0) },
  "least-sent": { label: "Least emails sent", compare: (a, b) => (a.totalEmailsSent ?? 0) - (b.totalEmailsSent ?? 0) },
  "last-replied": { label: "Last replied", compare: (a, b) => time(b.lastRepliedAt) - time(a.lastRepliedAt) },
  invalid: {
    label: "Invalid contacts first",
    compare: (a, b) => Number(["Invalid", "Hard Bounced"].includes(b.contactStatus)) - Number(["Invalid", "Hard Bounced"].includes(a.contactStatus)),
  },
  never: {
    label: "Never emailed first",
    compare: (a, b) => Number(!b.lastEmailedAt) - Number(!a.lastEmailedAt),
  },
};

const FILTERS: Record<string, { label: string; test: (c: Contact) => boolean }> = {
  [ALL]: { label: "All contacts", test: () => true },
  valid: { label: "Valid contacts", test: (c) => c.emailValidity === "Valid" && !sendRestriction(c) },
  never: { label: "Never contacted", test: (c) => !c.lastEmailedAt },
  previous: { label: "Previously contacted", test: (c) => !!c.lastEmailedAt },
  replied: { label: "Replied", test: (c) => c.replyStatus === "Replied" },
  hard: { label: "Hard bounced", test: (c) => c.contactStatus === "Hard Bounced" },
  soft: { label: "Soft bounced", test: (c) => c.contactStatus === "Soft Bounced" },
  blocked: { label: "Blocked", test: (c) => c.blocked },
};

/** Search, sort, filter and select recipients. Rows that can't be emailed stay visible but can't be ticked. */
export function RecipientSelector({
  contacts,
  loaded,
  selected,
  onChange,
  onOpenContact,
  timezone,
}: {
  contacts: Contact[];
  loaded: boolean;
  selected: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  onOpenContact: (id: string) => void;
  timezone?: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name-asc");
  const [filter, setFilter] = useState(ALL);
  const [company, setCompany] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [page, setPage] = useState(0);

  const companies = useMemo(() => [...new Set(contacts.map((c) => c.company).filter(Boolean))].sort(), [contacts]);
  const categories = useMemo(() => [...new Set(contacts.map((c) => c.category).filter(Boolean))].sort(), [contacts]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = contacts.filter((c) => {
      if (!FILTERS[filter].test(c)) return false;
      if (company !== ALL && c.company !== company) return false;
      if (category !== ALL && c.category !== category) return false;
      if (!q) return true;
      return [c.name, c.email, c.company, c.title, c.category].some((f) => f?.toLowerCase().includes(q));
    });
    return list.sort(SORTS[sort].compare);
  }, [contacts, query, filter, company, category, sort]);

  useEffect(() => setPage(0), [query, filter, company, category, sort]);

  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = matching.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const selectable = (list: Contact[]) => list.filter((c) => !sendRestriction(c));

  const selectMany = (list: Contact[], what: string) => {
    const ok = selectable(list);
    onChange({ ...selected, ...Object.fromEntries(ok.map((c) => [c.id, true])) });
    const left = list.length - ok.length;
    toast.success(`Selected ${ok.length} ${what}`, { description: left ? `${left} blocked, bounced or invalid not selected` : undefined });
  };

  const deselect = (list: Contact[]) => {
    const next = { ...selected };
    for (const c of list) delete next[c.id];
    onChange(next);
  };

  // A contact that became blocked or bounced meanwhile drops out of the selection.
  useEffect(() => {
    const stale = contacts.filter((c) => selected[c.id] && sendRestriction(c));
    if (stale.length) deselect(stale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]);

  const selectedCount = Object.values(selected).filter(Boolean).length;

  // Prefer contacts that haven't been emailed yet.
  const autoPick20 = () => {
    const ok = selectable(matching);
    const ordered = [...ok.filter((c) => !c.lastEmailedAt), ...ok.filter((c) => c.lastEmailedAt)].slice(0, 20);
    onChange(Object.fromEntries(ordered.map((c) => [c.id, true])));
    toast.success(`Selected ${ordered.length} contacts`);
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, email, company, job title, category…" className="pl-9" />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Picker label="Show" value={filter} onChange={setFilter} options={Object.entries(FILTERS).map(([value, f]) => ({ value, label: f.label }))} />
        <Picker label="Sort by" value={sort} onChange={setSort} options={Object.entries(SORTS).map(([value, s]) => ({ value, label: s.label }))} />
        <Picker label="Company" value={company} onChange={setCompany} options={[{ value: ALL, label: "All companies" }, ...companies.map((c) => ({ value: c, label: c }))]} />
        <Picker label="Category" value={category} onChange={setCategory} options={[{ value: ALL, label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={() => selectMany(contacts, "contacts")}>Select all</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => selectMany(visible, "on this page")}>Select visible</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => selectMany(matching, "matching the filter")}>Select by filter</Button>
        <Button type="button" size="sm" variant="outline" onClick={autoPick20}>Auto-select 20</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => deselect(matching)}>Deselect all</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange({})}>Clear selection</Button>
        <span className="ml-auto text-sm font-medium">Selected: {selectedCount} contact{selectedCount === 1 ? "" : "s"}</span>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-9 px-3 py-2" />
              <th className="px-2 py-2 font-medium">Contact</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Company / title</th>
              <th className="px-2 py-2 font-medium">Category</th>
              <th className="px-2 py-2 font-medium">Last sent</th>
              <th className="px-2 py-2 text-right font-medium">Sent</th>
              <th className="px-2 py-2 font-medium">Last email</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">{loaded ? "No contacts match." : "Loading…"}</td></tr>
            )}
            {visible.map((c) => {
              const restriction = sendRestriction(c);
              return (
                <tr key={c.id} className={restriction ? "opacity-60" : undefined} title={restriction?.message}>
                  <td className="px-3 py-2">
                    <Checkbox
                      checked={!!selected[c.id]}
                      disabled={!!restriction}
                      aria-label={`Select ${c.email}`}
                      onCheckedChange={(v) => onChange({ ...selected, [c.id]: !!v })}
                    />
                  </td>
                  <td className="max-w-[220px] px-2 py-2">
                    <button type="button" className="block max-w-full text-left hover:underline" onClick={() => onOpenContact(c.id)}>
                      <span className="block truncate font-medium">{c.name || c.email}</span>
                      {c.name && <span className="block truncate text-xs text-muted-foreground">{c.email}</span>}
                    </button>
                  </td>
                  <td className="px-2 py-2"><ContactStatusBadge status={c.contactStatus} /></td>
                  <td className="max-w-[170px] px-2 py-2">
                    <span className="block truncate">{c.company || "—"}</span>
                    {c.title && <span className="block truncate text-xs text-muted-foreground">{c.title}</span>}
                  </td>
                  <td className="max-w-[110px] truncate px-2 py-2 text-xs">{c.category}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{c.lastEmailedAt ? formatDateTime(c.lastEmailedAt, timezone).replace(/, .*$/, "") : "Never"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{c.totalEmailsSent ?? 0}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs">{c.lastEmailStatus || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{matching.length} of {contacts.length} contacts. Blocked, bounced and invalid contacts can't be selected; open a contact to review or correct it.</span>
        {pages > 1 && (
          <span className="flex items-center gap-1">
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={currentPage === 0} aria-label="Previous page" onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            Page {currentPage + 1} of {pages}
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={currentPage >= pages - 1} aria-label="Next page" onClick={() => setPage(currentPage + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </span>
        )}
      </div>
    </div>
  );
}

function Picker({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
