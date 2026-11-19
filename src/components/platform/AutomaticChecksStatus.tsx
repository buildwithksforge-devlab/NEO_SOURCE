import { Link } from '@tanstack/react-router';
import { useAutomaticPlatformChecks } from '@/lib/platform-automatic-checks';

export function AutomaticChecksStatus() {
  const checks = useAutomaticPlatformChecks();
  if (!checks.allowed) return null;
  return <div className="mb-4 rounded-lg border p-3 text-sm" role="status">
    {!checks.branchId ? 'Select a property to view its automatic integrity checks.'
      : checks.isError ? <span role="alert">Automatic checks could not finish: {checks.error instanceof Error ? checks.error.message : 'Refresh to retry.'} No readiness pass was recorded.</span>
      : checks.isPending ? 'Running and saving property integrity checks…'
      : <>Automatic integrity checks saved · {checks.data?.failed ?? 0} failed · {checks.data?.blocked ?? 0} blocked · {checks.data?.finished_at ? new Date(checks.data.finished_at).toLocaleString() : 'Time unavailable'}. </>}
    {' '}<Link to="/platform/quality" className="underline">Open results & defects</Link>
    <p className="mt-1 text-xs text-muted-foreground">Checks refresh every 15 minutes while open. Background checks require the installed database schedule. These checks do not replace workflow, provider or human approval evidence.</p>
  </div>;
}
