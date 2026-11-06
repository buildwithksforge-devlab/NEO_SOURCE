import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  resolve(
    process.cwd(),
    "src/routes/_shell.platform.printers.tsx",
  ),
  "utf8",
);

describe("printer administration page", () => {
  it("configures physical routing fields", () => {
    for (const field of [
      "printer_role",
      "station_id",
      "department_id",
      "connection_type",
      "address",
      "fallback_printer_id",
    ]) {
      expect(page).toContain(field);
    }
  });

  it("offers the four production destinations", () => {
    for (const role of [
      '"kitchen"',
      '"coffee"',
      '"bar"',
      '"pastry"',
    ]) {
      expect(page).toContain(role);
    }
  });

  it("creates a one-time property agent secret and stores only its hash", () => {
    expect(page).toContain(
      "crypto.getRandomValues",
    );

    expect(page).toContain(
      'crypto.subtle.digest(',
    );

    expect(page).toContain(
      "useRegisterPrintAgent",
    );

    expect(page).toContain(
      "tokenHash",
    );
  });

  it("limits backups to the same routing scope", () => {
    expect(page).toContain(
      "candidate.branch_id ===",
    );

    expect(page).toContain(
      "candidate.department_id ===",
    );

    expect(page).toContain(
      "candidate.station_id ===",
    );

    expect(page).toContain(
      "candidate.printer_role ===",
    );
  });

  it("does not let browser users report a print as successful", () => {
    expect(page).not.toContain(
      "useRecordPrintResult",
    );

    expect(page).not.toContain(
      "It printed",
    );

    expect(page).not.toContain(
      "It failed",
    );
  });

  it("retains explicit review before retrying an uncertain job", () => {
    expect(page).toContain(
      "Review and retry",
    );

    expect(page).toContain(
      'job.status === "failed"',
    );
  });
});