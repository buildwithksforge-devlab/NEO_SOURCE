import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { notificationSubject, visibleNotifications } from "@/lib/notifications-inbox";
import type { InboxNotification } from "@/lib/notifications-inbox";
import type { VisibilityContract } from "@/lib/visibility-contract";

const identity = readFileSync("src/components/brand/NeoIdentity.tsx", "utf8");
const glyph = readFileSync("src/components/brand/NeoGlyph.tsx", "utf8");
const frame = readFileSync("src/components/dashboard/DashboardFrame.tsx", "utf8");
const topbar = readFileSync("src/components/layout/Topbar.tsx", "utf8");
const notificationsRoute = readFileSync("src/routes/_shell.notifications.tsx", "utf8");

describe("footer signature", () => {
  it("is Powered by + the NEØ wordmark only", () => {
    expect(identity).not.toContain("Next-Generation Enterprise Operations");
    expect(identity).toContain("Powered by");
    expect(identity).toContain("NEO_WORDMARK_SRC");
  });

  it("keeps the full creator credit linked to the Instagram profile", () => {
    expect(glyph).toContain("Built by AI, Data &amp; Marketing by Wambui");
    expect(glyph).toContain("CREATOR_CREDIT_URL");
  });

  it("places a real full-colour Instagram mark before the credit text", () => {
    expect(glyph).toContain("neo-ig-gradient");
    const markIndex = glyph.indexOf("<InstagramMark");
    const textIndex = glyph.indexOf("Built by AI, Data &amp; Marketing by Wambui");
    expect(markIndex).toBeGreaterThan(-1);
    expect(markIndex).toBeLessThan(textIndex);
    expect(glyph).toContain("items-baseline");
  });
});

function contract(over: Partial<VisibilityContract> = {}) {
  return { receivesNotification: () => true, ...over } as unknown as VisibilityContract;
}

const base: InboxNotification = {
  id: "n1",
  category: "tasks",
  title: "t",
  body: "b",
  link: null,
  priority: "normal",
  read_at: null,
  created_at: new Date().toISOString(),
  action_required: false,
  status: "open",
  acted_at: null,
  source_module: null,
  source_record_id: null,
  event_type: null,
  user_id: null,
  branch_id: null,
  department_id: null,
  station_id: null,
};

describe("notification audience", () => {
  it("derives the audience from the narrowest addressing column", () => {
    expect(notificationSubject({ ...base, user_id: "u1" })).toEqual({
      audience: "personal",
      userId: "u1",
    });
    expect(notificationSubject({ ...base, station_id: "s1", department_id: "d1" })).toEqual({
      audience: "station",
      stationId: "s1",
    });
    expect(notificationSubject({ ...base, department_id: "d1", branch_id: "b1" })).toEqual({
      audience: "department",
      departmentId: "d1",
    });
    expect(notificationSubject({ ...base, branch_id: "b1" })).toEqual({
      audience: "property",
      branchId: "b1",
    });
    expect(notificationSubject(base)).toEqual({ audience: "organization" });
  });

  it("drops notices the reader is not authorised to receive", () => {
    const rows = [
      { ...base, id: "mine", user_id: "me" },
      { ...base, id: "theirs", user_id: "other" },
    ];
    const v = contract({
      receivesNotification: (n) => n.audience !== "personal" || n.userId === "me",
    });
    expect(visibleNotifications(rows, v).map((n) => n.id)).toEqual(["mine"]);
  });
});

describe("count and list reconcile", () => {
  it("uses one shared inbox for the badge and the page", () => {
    expect(topbar).toContain("useNotificationInbox");
    expect(topbar).not.toContain('queryKey: ["notifications-unread"');
    expect(notificationsRoute).toContain("useNotificationInbox");
    expect(notificationsRoute).toContain("inbox.unread");
  });
});

describe("dashboard scope selectors", () => {
  it("offers only authorised departments and stations", () => {
    expect(frame).toContain("visibility.departmentSelector()");
    expect(frame).toContain("visibility.stationSelector()");
    expect(frame).toContain("departmentScope.allowAll ? <SelectItem value={ALL}>");
    expect(frame).toContain("stationScope.allowAll ? <SelectItem value={ALL}>");
  });
});


// R9.2 contrast guard: informational public copy must not regress to decorative opacity.
import fs from "node:fs";
import path from "node:path";

describe("R9.2 contrast guard", () => {
  it("keeps front-door informational copy above decorative opacity", () => {
    const source = fs.readFileSync(path.resolve("src/components/front-door/FrontDoorScreen.tsx"), "utf8");
    expect(source).not.toMatch(/text-white\/(35|40|45|50|55)\b/);
  });
  it("keeps rider login attribution legible", () => {
    const source = fs.readFileSync(path.resolve("src/routes/rider.login.tsx"), "utf8");
    expect(source).toContain("text-white/80");
  });
});
