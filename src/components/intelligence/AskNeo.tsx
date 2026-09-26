/**
 * "Ask NEØ anything…" — a composer and an analysis workspace.
 *
 * An answer is not a chat bubble: it is assembled spatially. The conclusion and
 * its reasoning sit on the left, the visual NEØ chose sits beside it, the named
 * drivers sit underneath, evidence stays one click away and contextual next
 * questions continue the same investigation without leaving the page.
 *
 * Every answer is produced server-side from the signed-in user's authorised
 * intelligence payload. NEØ never invents a figure and never changes anything.
 */
import { useState, type FormEvent } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Loader2, SendHorizontal, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/common/DataDisplay";
import { EvidenceSummary, ScopeLine, StatementLine } from "@/components/intelligence/EvidencePanel";
import { NeoBrain } from "@/components/intelligence/NeoBrain";
import { VizRenderer } from "@/components/intelligence/VizRenderer";
import { SUGGESTED_QUESTIONS, followUpsFor } from "@/lib/intelligence-ask";
import type { ConversationTurn, Driver } from "@/lib/intelligence-types";

export function AskComposer({
  onAsk,
  busy,
  placeholder = "Ask NEØ anything…",
  compact,
}: {
  onAsk: (question: string) => void;
  busy: boolean;
  placeholder?: string;
  compact?: boolean;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q || busy) return;
    onAsk(q);
    setValue("");
  };
  return (
    <form onSubmit={submit} className="neo-ask-bar flex items-center gap-2 rounded-2xl border border-outline-subtle p-2">
      <Sparkles className="ml-1 size-4 shrink-0 text-primary" aria-hidden />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Ask NEØ a question about your operation"
        className="h-10 min-w-0 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
      />
      <Button type="submit" size={compact ? "sm" : "default"} disabled={busy || value.trim().length === 0}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
        <span className="ml-1.5 hidden sm:inline">Ask</span>
      </Button>
    </form>
  );
}

export function SuggestedQuestions({ onAsk, busy }: { onAsk: (q: string) => void; busy: boolean }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {SUGGESTED_QUESTIONS.map((q) => (
        <li key={q}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAsk(q)}
            className="rounded-full border border-outline-subtle px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Named contributors behind the headline. Only what the records name. */
function Drivers({ drivers }: { drivers: Driver[] }) {
  if (drivers.length === 0) return null;
  return (
    <div>
      <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Main drivers</p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {drivers.map((d) => {
          const Icon = d.direction === "up" ? ArrowUpRight : d.direction === "down" ? ArrowDownRight : ArrowRight;
          const tone =
            d.favourable === "bad" ? "text-warning" : d.favourable === "good" ? "text-success" : "text-muted-foreground";
          return (
            <li key={d.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl bg-card/60 px-3 py-2">
              <span className="truncate text-sm">{d.label}</span>
              <span className={`inline-flex shrink-0 items-center gap-1 text-sm font-medium tabular-nums ${tone}`}>
                <Icon className="size-3.5" aria-hidden />
                {d.value}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AnswerCard({
  turn,
  onAsk,
}: {
  turn: ConversationTurn;
  /** Continues the same investigation with a contextual question. */
  onAsk?: (question: string) => void;
}) {
  const answer = turn.answer;
  const followUps = answer ? (answer.followUps ?? followUpsFor(answer.topic)) : [];

  return (
    <article data-testid="ask-answer" className="neo-answer-card neo-rise space-y-4 rounded-2xl border border-outline-subtle p-4 sm:p-5">
      <header className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">You asked</p>
        <p className="text-sm font-medium">{turn.question}</p>
      </header>

      {turn.pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> NEØ is reading your authorised records…
        </p>
      ) : turn.error ? (
        <p className="text-sm text-destructive">{turn.error}</p>
      ) : answer ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="min-w-0 text-lg font-semibold leading-snug">{answer.headline}</h4>
            {answer.limitation ? <StatusPill tone="warning">NEØ cannot verify this yet</StatusPill> : null}
          </div>
          <ScopeLine scope={answer.scope} confidence={answer.confidence} />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-3">
              <ul className="divide-y divide-outline-subtle">
                {answer.statements.map((s, i) => (
                  <StatementLine key={i} statement={s} />
                ))}
              </ul>

              {turn.narrative ? (
                <div className="rounded-xl border border-outline-subtle bg-card/60 p-3">
                  <p className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    NEØ's reading of the facts above
                  </p>
                  <p className="text-sm leading-relaxed">{turn.narrative}</p>
                </div>
              ) : turn.narrativeStatus && turn.narrativeStatus !== "ok" && !answer.limitation ? (
                <p className="text-xs text-muted-foreground">
                  No language model is available for this workspace, so NEØ answered with the deterministic facts only.
                </p>
              ) : null}
            </div>

            <div className="min-w-0 space-y-3">
              <VizRenderer viz={answer.visualization} />
              <Drivers drivers={answer.drivers ?? []} />
            </div>
          </div>

          <EvidenceSummary evidence={answer.evidence} confidence={answer.confidence} scope={answer.scope}>
            {answer.modules.length > 0 ? (
              <NeoBrain active={answer.modules} caption="Modules this answer was derived from." />
            ) : null}
          </EvidenceSummary>

          {onAsk && followUps.length > 0 ? (
            <div>
              <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Continue</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {followUps.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => onAsk(q)}
                      className="inline-flex items-center gap-1 rounded-full border border-outline-subtle px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/60"
                    >
                      {q} <ArrowRight className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
