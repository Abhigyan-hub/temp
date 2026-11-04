import { useMemo, useState } from "react";
import { SpellCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { findSpellingSuggestions, type SpellingKind, type SpellingSuggestion } from "@/lib/contact-data";

/**
 * Possible typos for one field, each with Apply / Ignore. Nothing changes unless the user
 * clicks Apply; ignored suggestions stay hidden for that exact value.
 */
export function FieldSuggestions({
  value,
  kind,
  onApply,
  compact,
}: {
  value: string;
  kind: SpellingKind;
  onApply: (next: string, s: SpellingSuggestion) => void;
  compact?: boolean;
}) {
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set());
  const suggestions = useMemo(
    () => findSpellingSuggestions(value, kind).filter((s) => !ignored.has(`${s.original}|${s.from}`)),
    [value, kind, ignored],
  );
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-1">
      {suggestions.map((s) => (
        <div
          key={`${s.original}|${s.from}`}
          role="status"
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
            compact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs",
          )}
        >
          <SpellCheck className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            Possible typo: <span className="font-medium line-through decoration-amber-600/60">{s.from}</span> →{" "}
            <span className="font-medium">{s.to}</span>
            {!compact && (
              <span className="block truncate text-[11px] opacity-80" title={`${s.original} → ${s.suggestion}`}>
                {s.original} → {s.suggestion}
              </span>
            )}
          </span>
          <span className="ml-auto flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => onApply(s.suggestion, s)}
            >
              Apply suggestion
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setIgnored((prev) => new Set(prev).add(`${s.original}|${s.from}`))}
            >
              Ignore
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}
