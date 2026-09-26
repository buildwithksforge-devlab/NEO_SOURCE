import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("admin settings save truth", () => {
  it("does not claim a manual save when tenant settings are debounced/autosaved", () => {
    for (const file of ["src/routes/admin.hotel-information.tsx", "src/routes/admin.regional.tsx"]) {
      const source = read(file);
      expect(source).toContain("Changes save automatically");
      expect(source).not.toContain('toast.success("Hotel information saved")');
      expect(source).not.toContain('toast.success("Regional settings saved")');
    }
    const tenant = read("src/lib/tenant.tsx");
    expect(tenant).toContain("saveTenant(orgAtEdit, tenant)");
    expect(tenant).toContain("setTimeout");
  });
});
