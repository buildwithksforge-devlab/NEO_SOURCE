import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("admin configuration save truthfulness", () => {
  it("does not show fake success saves on tenant autosave screens", () => {
    const files = [
      "src/routes/admin.communication.tsx",
      "src/routes/admin.dashboard-appearance.tsx",
      "src/routes/admin.documents.tsx",
      "src/routes/admin.user-defaults.tsx",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/toast\.success\([^)]*(saved|Defaults saved)/i);
      expect(source).not.toContain("Save Changes");
    }
  });

  it("labels tenant-backed configuration as automatic persistence", () => {
    for (const file of [
      "src/routes/admin.communication.tsx",
      "src/routes/admin.dashboard-appearance.tsx",
      "src/routes/admin.documents.tsx",
    ]) {
      expect(read(file)).toContain("Changes save automatically");
    }
  });

  it("does not present read-only user defaults as writable", () => {
    expect(read("src/routes/admin.user-defaults.tsx")).toContain("Platform defaults · read only");
  });

  it("brand identity does not claim database success before debounced persistence completes", () => {
    const source = read("src/routes/admin.brand-identity.tsx");
    expect(source).toContain("NEØ is saving them automatically");
    expect(source).not.toContain("Brand identity saved");
  });
});
