/**
 * Normalisation and validation for staff account details.
 *
 * The same rules run in the Add staff user form and again inside the server
 * function, so a typed request cannot create an account the form would have
 * refused. Nothing here invents a value: it only trims, lower-cases and
 * formats what the administrator actually entered.
 */

export type StaffAccountInput = {
  full_name: string;
  email: string;
  phone: string;
  password: string;
  job_title: string;
  branch_id: string | null;
  department_id: string | null;
  employment_status: string;
  role_ids: string[];
};

/** Minimum accepted by the authentication provider for this project. */
export const MIN_PASSWORD_LENGTH = 8;

export function normaliseFullName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Stores a mobile number in international form when the shape is unambiguous:
 * a Kenyan national number (07xx/01xx) becomes +254…, an existing + number is
 * kept, and anything else is returned trimmed rather than guessed.
 */
export function normalisePhone(value: string): string {
  const raw = value.replace(/[\s()\-.]/g, "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  if (/^0\d{9}$/.test(raw)) return `+254${raw.slice(1)}`;
  if (/^254\d{9}$/.test(raw)) return `+${raw}`;
  return raw;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}

export function isValidPhone(value: string): boolean {
  if (!value) return true; // optional
  return /^\+?\d{7,15}$/.test(value);
}

export function normaliseStaffAccountInput<T extends StaffAccountInput>(input: T): T {
  return {
    ...input,
    full_name: normaliseFullName(input.full_name ?? ""),
    email: normaliseEmail(input.email ?? ""),
    phone: normalisePhone(input.phone ?? ""),
    job_title: (input.job_title ?? "").trim(),
    role_ids: Array.from(new Set(input.role_ids ?? [])),
  };
}

/**
 * Returns the first blocking problem in plain language, or `null` when the
 * account can be created. Field order matches the form so the message always
 * points at the first thing to correct.
 */
export function validateStaffAccountInput(input: StaffAccountInput): string | null {
  const name = normaliseFullName(input.full_name ?? "");
  if (name.length < 2) return "Enter the staff member's full name.";
  if (name.length > 120) return "Full name must be 120 characters or fewer.";

  const email = normaliseEmail(input.email ?? "");
  if (!email) return "Enter an email address.";
  if (!isValidEmail(email)) return "That email address is not valid.";
  if (email.length > 255) return "Email address must be 255 characters or fewer.";

  const phone = normalisePhone(input.phone ?? "");
  if (!isValidPhone(phone)) {
    return "Enter a valid mobile number, for example 0712 345 678 or +254712345678.";
  }

  if ((input.password ?? "").length < MIN_PASSWORD_LENGTH) {
    return `The temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (!input.branch_id) return "Select the property this staff member works at.";
  if (!input.department_id) return "Select a department.";
  if (!input.employment_status) return "Select an employment status.";
  if (!input.role_ids?.length) return "Select at least one role.";

  return null;
}

/** A duplicate account is reported as such rather than as a provider error. */
export function isDuplicateAccountError(message: string): boolean {
  return /already\s+(been\s+)?registered|already exists|duplicate key/i.test(message);
}
