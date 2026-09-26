import { describe, expect, it } from "vitest";
import {
  isDuplicateAccountError,
  normalisePhone,
  normaliseStaffAccountInput,
  validateStaffAccountInput,
} from "@/lib/staff-account-input";

const complete = {
  full_name: "  Amina   Yusuf ",
  email: " Amina.Yusuf@Example.COM ",
  phone: "0712 345 678",
  password: "Temp1234",
  job_title: " Receptionist ",
  branch_id: "b-1",
  department_id: "d-1",
  employment_status: "full-time",
  role_ids: ["r-1", "r-1"],
};

describe("staff account normalisation", () => {
  it("trims the name, lower-cases the email and de-duplicates roles", () => {
    const out = normaliseStaffAccountInput(complete);
    expect(out.full_name).toBe("Amina Yusuf");
    expect(out.email).toBe("amina.yusuf@example.com");
    expect(out.job_title).toBe("Receptionist");
    expect(out.role_ids).toEqual(["r-1"]);
  });

  it("stores Kenyan mobile numbers in international form without guessing others", () => {
    expect(normalisePhone("0712 345 678")).toBe("+254712345678");
    expect(normalisePhone("254712345678")).toBe("+254712345678");
    expect(normalisePhone("+44 20 7946 0000")).toBe("+442079460000");
    expect(normalisePhone("")).toBe("");
  });
});

describe("staff account validation", () => {
  it("accepts a complete entry", () => {
    expect(validateStaffAccountInput(normaliseStaffAccountInput(complete))).toBeNull();
  });

  it.each([
    ["full_name", "A", "Enter the staff member's full name."],
    ["email", "not-an-email", "That email address is not valid."],
    ["phone", "12ab", "Enter a valid mobile number, for example 0712 345 678 or +254712345678."],
    ["password", "short", "The temporary password must be at least 8 characters."],
  ])("refuses an invalid %s", (field, value, message) => {
    const input = normaliseStaffAccountInput({ ...complete, [field]: value });
    expect(validateStaffAccountInput(input)).toBe(message);
  });

  it.each([
    ["branch_id", "Select the property this staff member works at."],
    ["department_id", "Select a department."],
    ["employment_status", "Select an employment status."],
  ])("requires %s", (field, message) => {
    const input = normaliseStaffAccountInput({ ...complete, [field]: "" });
    expect(validateStaffAccountInput(input)).toBe(message);
  });

  it("requires at least one role", () => {
    const input = normaliseStaffAccountInput({ ...complete, role_ids: [] });
    expect(validateStaffAccountInput(input)).toBe("Select at least one role.");
  });
});

describe("duplicate account detection", () => {
  it("recognises the provider's duplicate messages", () => {
    expect(isDuplicateAccountError("A user with this email address has already been registered")).toBe(true);
    expect(isDuplicateAccountError("duplicate key value violates unique constraint")).toBe(true);
    expect(isDuplicateAccountError("Database connection failed")).toBe(false);
  });
});
