/**
 * Ask NEØ — departmental composer and answer.
 *
 * Same engine, narrower brain: the question goes to the server, the server
 * re-reads only what this person's permissions already release, and the answer
 * is assembled from those figures. Nothing here estimates, and nothing here
 * changes an operational record.
 */
import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Loader2, SendHorizontal, ShieldAlert, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/common/DataDisplay";
import { askNeoDepartment } from "@/lib/department-ask.functions";
import { suggestionsFor, type DepartmentAnswer } from "@/lib/department-ask";
import type { WorkItem } from "@/lib/my-work";

const TONE_CLASS: Record<string, string> = {
  critical: "border-destructive/40 bg-destructive/5",
  warning: "border-warning/40 bg-warning/5",
  info: "border-outline-subtle bg-surface-2/60",
  ok: "border-outline-subtle bg-surface-2/40",
};

export function DepartmentAsk({
  items,
  branchId,
  propertyLabel,
}: {
  items: WorkItem[];
  branchId: string | null;
  propertyLabel: string;
}) {
  const ask = useServerFn(askNeoDepartment);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<DepartmentAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const suggestions = suggestionsFor(items);

  const run = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await ask({ data: { question: q, branchId, propertyLabel } });
      if (result.ok && result.answer) setAnswer(result.answer as DepartmentAnswer);
      else setFailure("NEØ could not read that question.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "NEØ is unavailable right now.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(value);
    setValue("");
  };

  return (
    <SectionCard
      title="Ask NEØ"
      description={`NEØ answers from the records your permissions already reach in ${propertyLabel}. It will say so when a question goes further.`}
    >
      <div className="space-y-4" data-testid="department-ask">
        <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-outline-subtle p-2">
          <Sparkles className="ml-1 size-4 shrink-0 text-primary" aria-hidden />
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Ask NEØ about your work…"
            aria-label="Ask NEØ a question about your own work"
            className="h-10 min-w-0 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <Button type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
            <span className="ml-1.5 hidden sm:inline">Ask</span>
          </Button>
        </form>

        {suggestions.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {suggestions.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(q)}
                  className="rounded-full border border-outline-subtle px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {failure ? (
          <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            {failure}
          </p>
        ) : null}

        {answer ? (
          <article data-testid="department-answer" className="space-y-3 rounded-2xl border border-outline-subtle p-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">You asked</p>
              <p className="text-sm font-medium">{answer.question}</p>
            </div>
            <p className="text-base font-semibold leading-snug">{answer.headline}</p>

            {answer.limitation ? (
              <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {answer.limitation}
              </p>
            ) : null}

            {answer.statements.length > 0 ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {answer.statements.map((s) => (
                  <li key={s.label}>
                    <Link
                      to={s.route}
                      className={`group flex min-w-0 flex-col gap-0.5 rounded-xl border p-3 transition-colors hover:border-primary/40 ${
                        TONE_CLASS[s.tone] ?? TONE_CLASS["info"]
                      }`}
                    >
                      <span className="text-xl font-semibold tabular-nums">{s.value}</span>
                      <span className="text-sm font-medium leading-snug">{s.label}</span>
                      <span className="text-xs text-muted-foreground">{s.detail}</span>
                      <span className="mt-1 inline-flex items-center gap-1 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
                        Open <ArrowRight className="size-3" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="text-xs text-muted-foreground">
              Answered from {answer.scope.propertyLabel}
              {answer.scope.today ? ` · ${answer.scope.today}` : ""} · figures read from your permitted records only.
            </p>
          </article>
        ) : null}
      </div>
    </SectionCard>
  );
}
