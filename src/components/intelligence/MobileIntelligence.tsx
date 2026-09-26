/**
 * NEØ Intelligence on a phone or tablet.
 *
 * The desktop editorial layout does not survive a narrow column, so on small
 * screens the same deterministic findings collapse into three things a person
 * can use one-handed:
 *
 *  1. a swipeable NEØ Brief — one finding per card, scroll-snapped, with the
 *     evidence and confidence it already carries;
 *  2. Ask NEØ by text, or by voice where the browser provides recognition
 *     (progressive enhancement only — nothing depends on it);
 *  3. the recommended action, which never mutates anything here: it opens the
 *     module where an authorised person approves it.
 *
 * Any chart can be opened full-screen in an accessible dialog.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Expand, Mic, MicOff, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusPill } from "@/components/common/DataDisplay";
import { EvidenceSummary } from "@/components/intelligence/EvidencePanel";
import { VizRenderer } from "@/components/intelligence/VizRenderer";
import { MODULE_LABEL, type Decision, type Discovery, type Visualization } from "@/lib/intelligence-types";

/* ------------------------------------------------------------------ *
 * Voice input — optional, never required.
 * ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
function speechRecogniser(): any | null {
  if (typeof window === "undefined") return null;
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function useVoiceInput(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const ref = useRef<any>(null);

  useEffect(() => {
    setSupported(speechRecogniser() !== null);
  }, []);

  const toggle = () => {
    if (listening) {
      ref.current?.stop?.();
      setListening(false);
      return;
    }
    const recogniser = speechRecogniser();
    if (!recogniser) return;
    ref.current = recogniser;
    recogniser.lang = "en-GB";
    recogniser.interimResults = false;
    recogniser.maxAlternatives = 1;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    recogniser.onresult = (event: any) => {
      const text = event?.results?.[0]?.[0]?.transcript;
      if (typeof text === "string" && text.trim()) onResult(text.trim());
    };
    recogniser.onend = () => setListening(false);
    recogniser.onerror = () => setListening(false);
    recogniser.start();
    setListening(true);
  };

  return { supported, listening, toggle } as const;
}

export function VoiceAskButton({ onResult }: { onResult: (text: string) => void }) {
  const { supported, listening, toggle } = useVoiceInput(onResult);
  if (!supported) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant={listening ? "default" : "outline"}
      onClick={toggle}
      aria-pressed={listening}
      aria-label={listening ? "Stop voice input" : "Ask NEØ by voice"}
    >
      {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      {listening ? "Listening" : "Speak"}
    </Button>
  );
}

/* ------------------------------------------------------------------ *
 * Full-screen graph.
 * ------------------------------------------------------------------ */

export function GraphFullscreen({
  viz,
  label = "Open full screen",
}: {
  viz: Visualization | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!viz) return null;
  const title = "title" in viz ? viz.title : "Chart";
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Expand className="size-4" /> {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] w-full max-w-[min(96vw,72rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">{title}</DialogTitle>
          </DialogHeader>
          <VizRenderer viz={viz} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Swipeable brief.
 * ------------------------------------------------------------------ */

export function SwipeableBrief({
  discoveries,
  onInvestigate,
}: {
  discoveries: Discovery[];
  onInvestigate?: (topic: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);

  if (discoveries.length === 0) return null;

  const onScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const width = track.clientWidth || 1;
    setIndex(Math.round(track.scrollLeft / width));
  };

  return (
    <section aria-label="NEØ Brief" data-testid="mobile-brief" className="min-w-0 space-y-2">
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="neo-swipe-track flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1"
      >
        {discoveries.map((d) => (
          <article
            key={d.id}
            data-testid="mobile-brief-card"
            className="min-w-[min(88vw,26rem)] shrink-0 snap-center space-y-3 rounded-2xl border border-outline-subtle p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                tone={d.severity === "critical" ? "destructive" : d.severity === "warning" ? "warning" : "info"}
              >
                {d.severity}
              </StatusPill>
              {d.confidence ? (
                <StatusPill tone={d.confidence === "high" ? "success" : d.confidence === "moderate" ? "info" : "warning"}>
                  {d.confidence} confidence
                </StatusPill>
              ) : null}
            </div>
            <h3 className="text-base font-semibold leading-snug">{d.title}</h3>
            <p className="text-sm leading-snug text-muted-foreground">{d.conclusion}</p>
            <p className="text-xs text-muted-foreground">
              {d.modules.map((m) => MODULE_LABEL[m]).join(" · ")}
            </p>
            {d.confidence ? (
              <EvidenceSummary evidence={d.evidence} confidence={d.confidence}>
                <p className="text-xs text-muted-foreground">{d.confidenceNote}</p>
              </EvidenceSummary>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {d.investigate && onInvestigate ? (
                <Button size="sm" variant="secondary" onClick={() => onInvestigate(d.investigate as string)}>
                  <ScanSearch className="size-4" /> Investigate
                </Button>
              ) : null}
              {d.drillTo ? (
                <Button asChild size="sm" variant="outline">
                  <Link to={d.drillTo}>
                    See records <ArrowUpRight className="size-3.5" />
                  </Link>
                </Button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        {index + 1} of {discoveries.length} — swipe for the next finding
      </p>
    </section>
  );
}

/**
 * The single recommended action, phone-sized. NEØ never applies it: the button
 * opens the module route where an authorised person approves the work.
 */
export function RecommendedAction({ decision }: { decision: Decision | null }) {
  if (!decision) return null;
  return (
    <section
      data-testid="mobile-recommended-action"
      className="min-w-0 space-y-2 rounded-2xl border border-outline-subtle p-4"
    >
      <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">
        Recommended next action
      </p>
      <h3 className="text-sm font-semibold leading-snug">{decision.headline}</h3>
      <p className="text-sm text-muted-foreground">{decision.why}</p>
      {decision.action ? (
        <Button asChild size="sm" className="w-full">
          <Link to={decision.action.to}>{decision.action.label}</Link>
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          No approval route is available to you for this recommendation.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Approval happens in the module, under your existing authority.
      </p>
    </section>
  );
}
