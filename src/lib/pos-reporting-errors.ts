/**
 * Human-readable POS reporting errors.
 *
 * Preserve the distinction between unavailable functions,
 * permission failures and unexpected query errors.
 */
export function posReportingErrorMessage(
  error: unknown,
): string {
  const details =
    error && typeof error === "object"
      ? (error as {
          code?: string;
          message?: string;
        })
      : null;

  if (
    details?.code === "PGRST202" ||
    details?.code === "42883"
  ) {
    return (
      "Required reporting database function unavailable. " +
      "Verify that the corresponding SQL migration has been " +
      "installed and exposed to the database API."
    );
  }

  if (details?.code === "42501") {
    return (
      "Reporting access denied. Verify the employee's " +
      "reporting permission and selected property scope."
    );
  }

  return (
    "Reporting evidence could not be loaded. " +
    (details?.message ?? "Check the reporting period and connection.")
  );
}
