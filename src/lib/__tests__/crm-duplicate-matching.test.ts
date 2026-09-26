import { describe, expect, it } from "vitest";
import {
  computeDuplicateGroups,
  normalizeEmailIdentifier,
  normalizeNameIdentifier,
  normalizePhoneIdentifier,
  type Customer,
} from "@/lib/crm";

function guest(patch: Partial<Customer> & { id: string }): Customer {
  return {
    organization_id: "org",
    primary_branch_id: null,
    auth_user_id: null,
    customer_number: `CUS-${patch.id}`,
    customer_type: "individual-guest",
    full_name: "",
    preferred_name: "",
    nationality: "",
    date_of_birth: null,
    anniversary_date: null,
    phone: "",
    alt_phone: "",
    email: "",
    address: "",
    city: "",
    country: "",
    occupation: "",
    company: "",
    job_title: "",
    preferred_language: "",
    corporate_account_id: null,
    account_manager_id: null,
    is_vip: false,
    vip_notes: "",
    account_status: "active",
    marketing_consent: false,
    source: "",
    last_interaction_at: null,
    archived_at: null,
    merged_into_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  } as Customer;
}

describe("duplicate identifier normalisation", () => {
  it("refuses blank, junk and malformed emails", () => {
    for (const value of ["", "   ", "b", "n/a", "test", "not-an-email", "a@b"]) {
      expect(normalizeEmailIdentifier(value)).toBeNull();
    }
    expect(normalizeEmailIdentifier(" Guest.One@Example.COM ")).toBe("guest.one@example.com");
  });

  it("refuses blank, short and repeated-digit phones", () => {
    for (const value of ["", "n", "0712", "000000000", "111111111"]) {
      expect(normalizePhoneIdentifier(value)).toBeNull();
    }
    expect(normalizePhoneIdentifier("+254712345678")).toBe("712345678");
    expect(normalizePhoneIdentifier("0712 345 678")).toBe("712345678");
  });

  it("refuses single-token and placeholder names", () => {
    for (const value of ["", "jk", "mmm", "ddd", "tr", "Fnnn", "Guest"]) {
      expect(normalizeNameIdentifier(value)).toBeNull();
    }
    expect(normalizeNameIdentifier("Kelvin  Manz")).toBe("kelvin manz");
  });
});

describe("duplicate grouping", () => {
  it("never groups profiles that share only blank contact details", () => {
    const rows = [
      guest({ id: "1", full_name: "jk" }),
      guest({ id: "2", full_name: "mmm" }),
      guest({ id: "3", full_name: "ddd" }),
      guest({ id: "4", full_name: "Keisha King" }),
      guest({ id: "5", full_name: "Robert Titus" }),
      guest({ id: "6", full_name: "Joy Nduta" }),
    ];
    expect(computeDuplicateGroups(rows)).toEqual([]);
  });

  it("groups on a real shared email", () => {
    const rows = [
      guest({ id: "1", full_name: "Guest One", email: "same@example.com" }),
      guest({ id: "2", full_name: "Guest One", email: "SAME@example.com " }),
      guest({ id: "3", full_name: "Other Person", email: "other@example.com" }),
    ];
    const groups = computeDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toBe("email");
    expect(groups[0]!.customers.map((c) => c.id).sort()).toEqual(["1", "2"]);
  });

  it("groups on the same phone written in different formats", () => {
    const rows = [
      guest({ id: "1", full_name: "Guest One", phone: "+254712345678" }),
      guest({ id: "2", full_name: "Guest Two", phone: "0712345678" }),
    ];
    const groups = computeDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toBe("phone");
  });

  it("only matches on name when both records carry a birth date", () => {
    const withoutDob = [
      guest({ id: "1", full_name: "Kelvin Manz" }),
      guest({ id: "2", full_name: "Kelvin Manz" }),
    ];
    expect(computeDuplicateGroups(withoutDob)).toEqual([]);

    const withDob = [
      guest({ id: "1", full_name: "Kelvin Manz", date_of_birth: "1990-04-02" }),
      guest({ id: "2", full_name: "kelvin  manz", date_of_birth: "1990-04-02" }),
      guest({ id: "3", full_name: "Kelvin Manz", date_of_birth: "1991-04-02" }),
    ];
    const groups = computeDuplicateGroups(withDob);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toBe("name");
    expect(groups[0]!.customers.map((c) => c.id).sort()).toEqual(["1", "2"]);
  });

  it("ignores profiles already merged", () => {
    const rows = [
      guest({ id: "1", full_name: "Guest One", email: "same@example.com" }),
      guest({ id: "2", full_name: "Guest One", email: "same@example.com", merged_into_id: "1" }),
    ];
    expect(computeDuplicateGroups(rows)).toEqual([]);
  });
});
