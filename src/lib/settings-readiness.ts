import type { SettingsCategory, SettingsEntry } from "./settings-catalogue";
import type { SettingsStatus, SettingsStatusMap } from "./settings-status";

/**
 * Configuration readiness roll-up.
 *
 * The Configuration Centre landing shows how ready each domain is. Every
 * number here is derived from statuses observed in the database — a surface we
 * cannot measure is counted as "not measured", never quietly as configured.
 */

export type DomainReadiness = {
  /** Surfaces registered in the domain. */
  total: number;
  /** Surfaces whose status we could actually observe. */
  measured: number;
  configured: number;
  needsSetup: number;
  attention: number;
};

/** The key a catalogue entry is measured under, or null when it has neither. */
export function entryStatusKey(entry: SettingsEntry): string | null {
  if (entry.to) return entry.to;
  if (entry.panel) return `panel:${entry.panel}`;
  return null;
}

export function entryStatus(entry: SettingsEntry, statuses?: SettingsStatusMap): SettingsStatus {
  const key = entryStatusKey(entry);
  if (!key) return "unknown";
  return statuses?.[key] ?? "unknown";
}

export function domainReadiness(
  category: SettingsCategory,
  statuses?: SettingsStatusMap | undefined,
): DomainReadiness {
  const out: DomainReadiness = {
    total: category.entries.length,
    measured: 0,
    configured: 0,
    needsSetup: 0,
    attention: 0,
  };
  for (const entry of category.entries) {
    const status = entryStatus(entry, statuses);
    if (status === "unknown") continue;
    out.measured += 1;
    if (status === "configured") out.configured += 1;
    else if (status === "needs-setup") out.needsSetup += 1;
    else out.attention += 1;
  }
  return out;
}

export function centreReadiness(
  categories: readonly SettingsCategory[],
  statuses?: SettingsStatusMap | undefined,
): DomainReadiness {
  return categories.reduce<DomainReadiness>(
    (acc, category) => {
      const d = domainReadiness(category, statuses);
      return {
        total: acc.total + d.total,
        measured: acc.measured + d.measured,
        configured: acc.configured + d.configured,
        needsSetup: acc.needsSetup + d.needsSetup,
        attention: acc.attention + d.attention,
      };
    },
    { total: 0, measured: 0, configured: 0, needsSetup: 0, attention: 0 },
  );
}

/** Honest one-line summary for a domain tile. */
export function readinessLabel(readiness: DomainReadiness): string {
  if (readiness.measured === 0) return "Readiness not measured";
  if (readiness.attention > 0) return `${readiness.attention} need attention`;
  if (readiness.needsSetup > 0) return `${readiness.needsSetup} awaiting setup`;
  return "All measured surfaces configured";
}

export type ReadinessTone = "attention" | "warning" | "ready" | "neutral";

export function readinessTone(readiness: DomainReadiness): ReadinessTone {
  if (readiness.measured === 0) return "neutral";
  if (readiness.attention > 0) return "attention";
  if (readiness.needsSetup > 0) return "warning";
  return "ready";
}
