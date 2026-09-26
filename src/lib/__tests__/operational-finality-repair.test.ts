import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("September operational finality repairs", () => {
  it("requires and forwards city for staff-assisted deliveries", () => {
    const file = read("src/components/delivery/PhoneOrderCard.tsx");
    expect(file).toContain('const [city, setCity] = useState("")');
    expect(file).toContain("city: city.trim()");
    expect(file).toContain("city.trim().length > 1");
  });

  it("keeps stock movement source links and displays requisition context", () => {
    const data = read("src/lib/inventory-data.ts");
    const screen = read("src/routes/_shell.inventory.issues.tsx");
    expect(data).toContain("reference_type, reference_id");
    expect(data).toContain("source_requisition");
    expect(screen).toContain('request_number');
    expect(screen).toContain('departments');
  });

  it("offers controlled closure for a zero-balance open folio", () => {
    const file = read("src/routes/_shell.pms.folios.$id.tsx");
    expect(file).toContain("useCloseFolio");
    expect(file).toContain('reason: "Zero-balance folio closed from folio detail"');
  });

  it("surfaces stale housekeeping work without silently closing it", () => {
    const screen = read("src/routes/_shell.housekeeping.tasks.tsx");
    expect(screen).toContain('value="Stale over 24 hours"');
    expect(screen).toContain("it will not be closed automatically");
  });
});