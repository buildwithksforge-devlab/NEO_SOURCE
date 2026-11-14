import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("physical print-agent contract", () => {
  const migration = source(
    "supabase/migrations/20261101123000_complete_physical_print_agent.sql",
  );

  const route = source(
    "src/routes/api/public/print-agent.$action.ts",
  );

  const agent = source(
    "scripts/neo-print-agent.mjs",
  );

  const rawBridge = source(
    "scripts/neo-print-raw.ps1",
  );

  it("defines every RPC used by the public print-agent route", () => {
    for (const rpc of [
      "neo_print_agent_printers",
      "neo_print_agent_claim",
      "neo_print_agent_finish",
    ]) {
      expect(route).toContain(`"${rpc}"`);
      expect(migration).toContain(
        `FUNCTION public.${rpc}`,
      );
    }
  });

  it("keeps print-agent execution service-role only", () => {
    expect(migration).toContain(
      "FROM PUBLIC, anon, authenticated",
    );

    expect(migration).toContain(
      "TO service_role",
    );

    expect(agent).not.toContain(
      "SUPABASE_SERVICE_ROLE",
    );

    expect(agent).not.toContain(
      "service_role",
    );
  });

  it("claims jobs atomically and prevents silent duplicate recovery", () => {
    expect(migration).toContain(
      "FOR UPDATE SKIP LOCKED",
    );

    expect(migration).toContain(
      "claim_expires_at",
    );

    expect(migration).toContain(
      "physical outcome is unknown",
    );

    expect(agent).toContain(
      '"outcome_unknown"',
    );
  });

  it("enforces property, department and station printer isolation", () => {
    expect(migration).toContain(
      "printer_property_mismatch",
    );

    expect(migration).toContain(
      "fallback_printer_scope_mismatch",
    );

    expect(migration).toContain(
      "production_printer_station_mismatch",
    );

    expect(migration).toContain(
      "fp.department_id",
    );

    expect(migration).toContain(
      "fp.station_id",
    );
  });

  it("queues production jobs after complete canonical station routing", () => {
    expect(migration).toContain(
      "CREATE CONSTRAINT TRIGGER neo_print_after_station_ticket_item_trg",
    );

    expect(migration).toContain(
      "ON public.station_ticket_items",
    );

    expect(migration).toContain(
      "DEFERRABLE INITIALLY DEFERRED",
    );

    expect(migration).toContain(
      "public.neo_print_queue_station_tickets(",
    );

    expect(migration).not.toContain(
      "neo_pos_send_to_kitchen",
    );

    expect(migration).toContain(
      "'production-ticket:' || v_ticket.ticket_id::text",
    );

    expect(migration).toContain(
      "'production_ticket'",
    );
  });
  it("captures canonical POS receipt content before agent delivery", () => {
    expect(migration).toContain(
      "public.neo_document_payload",
    );

    expect(migration).toContain(
      "'pos_receipt'",
    );

    expect(agent).toContain(
      "receiptLines(job)",
    );
  });

  it("supports network ESC/POS and Windows RAW printing", () => {
    expect(agent).toContain(
      "createConnection",
    );

    expect(agent).toContain(
      "neo-print-raw.ps1",
    );

    expect(agent).toContain(
      "Buffer.from([0x1d, 0x56, 0x00])",
    );

    expect(rawBridge).toContain(
      'pDataType = "RAW"',
    );

    expect(rawBridge).toContain(
      "WritePrinter",
    );
  });

  it("never marks a job complete before delivery returns", () => {
    const delivery = agent.indexOf(
      "await deliver(job)",
    );

    const completion = agent.indexOf(
      '"completed"',
      delivery,
    );

    expect(delivery).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(delivery);
  });
});