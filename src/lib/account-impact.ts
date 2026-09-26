/**
 * Impact previews and the guided two-factor workflow for account actions.
 *
 * Every consequential account action states, before it runs, what will change,
 * what deliberately will not change, and whether it can be undone. Nothing here
 * reads or reveals a credential: two-factor state is described only as an
 * enrolment count, and passwords are replaced, never displayed.
 */

import type { UserActionTarget } from "@/lib/user-actions";

export type MfaState = "enrolled" | "not_enrolled" | "unknown";

export type AccountImpact = {
  headline: string;
  /** What the action changes, in the order the person will experience it. */
  changes: string[];
  /** What the action deliberately leaves untouched. */
  unchanged: string[];
  reversible: boolean;
  /** Present when the action cannot be performed in the current state. */
  blocked?: string;
};

export function mfaStateFromFactors(count: number | null | undefined): MfaState {
  if (count === null || count === undefined) return "unknown";
  return count > 0 ? "enrolled" : "not_enrolled";
}

export const MFA_STATE_LABELS: Record<MfaState, string> = {
  enrolled: "Two-factor enrolled",
  not_enrolled: "Not enrolled",
  unknown: "Enrolment state not loaded",
};

/**
 * Guided two-factor step for the Access & security menu. A reset is only
 * offered where there is an enrolment to clear, so the control is never a
 * no-op presented as an action.
 */
export function mfaWorkflow(state: MfaState, factors: number | null): {
  label: string;
  detail: string;
  guidance: string;
  canReset: boolean;
  blockedReason?: string;
} {
  if (state === "enrolled") {
    return {
      label: MFA_STATE_LABELS.enrolled,
      detail: `${factors ?? 1} device(s) enrolled`,
      guidance:
        "Resetting clears the enrolled device(s). The person is prompted to enrol a new device at their next sign-in. Recovery codes and secrets are never shown here.",
      canReset: true,
    };
  }
  if (state === "not_enrolled") {
    return {
      label: MFA_STATE_LABELS.not_enrolled,
      detail: "No two-factor device on this account",
      guidance:
        "There is nothing to reset. The person enrols a device themselves from their own security settings; an administrator cannot enrol on their behalf.",
      canReset: false,
      blockedReason: "This account has no two-factor enrolment to clear.",
    };
  }
  return {
    label: MFA_STATE_LABELS.unknown,
    detail: "Load the account state to continue",
    guidance: "Two-factor state is read from the account record when this panel opens.",
    canReset: false,
    blockedReason: "Two-factor state has not been read yet.",
  };
}

/** Password-requirement step, driven by the current requirement flag. */
export function passwordWorkflow(target: Pick<UserActionTarget, "must_change_password">): {
  label: string;
  guidance: string;
  requirementOutstanding: boolean;
} {
  const outstanding = target.must_change_password === true;
  return {
    label: outstanding ? "Password change outstanding" : "No password change required",
    guidance: outstanding
      ? "The person must set a new password before they can continue working. Clearing the requirement lets them keep their current password."
      : "Setting a temporary password automatically re-applies the change-at-next-sign-in requirement.",
    requirementOutstanding: outstanding,
  };
}

/**
 * The impact preview for one action against one account. Written for the
 * administrator, not the database: plain consequences, no SQL and no secrets.
 */
export function accountActionImpact(
  actionId: string,
  ctx: {
    target: Pick<UserActionTarget, "account_status" | "must_change_password" | "email" | "isOwner">;
    mfaState?: MfaState;
    /** Offboarding only: whether system access is closed with the exit. */
    revokeAccess?: boolean;
  },
): AccountImpact {
  const { target } = ctx;
  const mfa = ctx.mfaState ?? "unknown";

  switch (actionId) {
    case "reset_password":
      return {
        headline: "Issue a temporary password",
        changes: [
          "The current password stops working immediately.",
          "Open sessions continue until they expire — use Force sign-out to end them now.",
          "A password change is required at the next sign-in.",
        ],
        unchanged: [
          "Roles, property and department assignment.",
          "Two-factor enrolment.",
          "The existing password is never shown to anyone, including you.",
        ],
        reversible: false,
      };
    case "require_password_change":
      return {
        headline: "Require a new password at next sign-in",
        changes: ["The next sign-in stops at a password change before any work can continue."],
        unchanged: ["The current password keeps working until it is changed.", "Access rights."],
        reversible: true,
      };
    case "clear_password_requirement":
      return {
        headline: "Clear the outstanding password-change requirement",
        changes: ["The person can carry on with their current password."],
        unchanged: ["The password itself.", "Access rights."],
        reversible: true,
      };
    case "resend_invitation":
      return {
        headline: "Resend the setup email",
        changes: [`A fresh setup link is emailed to ${target.email ?? "the address on file"}.`],
        unchanged: ["Any previously completed setup.", "Access rights."],
        reversible: true,
      };
    case "revoke_sessions":
      return {
        headline: "Sign this account out everywhere",
        changes: [
          "Every open session and device is signed out at once.",
          "The person must sign in again to continue.",
        ],
        unchanged: ["Password.", "Two-factor enrolment.", "Roles and assignment."],
        reversible: true,
      };
    case "reset_mfa": {
      const flow = mfaWorkflow(mfa, null);
      return {
        headline: "Clear two-factor enrolment",
        changes: [
          "Enrolled two-factor devices are removed.",
          "The person enrols a new device at their next sign-in.",
        ],
        unchanged: ["Password.", "Roles and assignment.", "No secret or recovery code is displayed."],
        reversible: false,
        ...(flow.canReset ? {} : { blocked: flow.blockedReason }),
      };
    }
    case "suspend":
      return {
        headline: "Lock the account",
        changes: [
          "Sign-in is blocked immediately.",
          "Existing sessions are refused on their next request.",
        ],
        unchanged: [
          "Employment status — ending employment is an HR decision.",
          "Roles, assignment and history, so access returns unchanged on unlock.",
        ],
        reversible: true,
      };
    case "deactivate":
      return {
        headline: "Close account access",
        changes: ["Sign-in is closed.", "The person disappears from active staff selectors."],
        unchanged: ["Staff record, documents and audit history."],
        reversible: true,
      };
    case "activate":
      return {
        headline: "Restore access",
        changes: ["Sign-in works again with the existing roles and scope."],
        unchanged: ["Password and two-factor enrolment."],
        reversible: true,
      };
    case "offboard": {
      const revoke = ctx.revokeAccess !== false;
      return {
        headline: "End employment through HR",
        changes: [
          "Employment history and the exit clearance record are written.",
          revoke
            ? "Role assignments are closed and sign-in is revoked."
            : "Sign-in and role assignments are left in place for the notice period.",
        ],
        unchanged: [
          "The staff record, documents and audit trail are retained.",
          "Completed transactions stay attributed to this person.",
        ],
        reversible: false,
      };
    }
    case "delete_account":
      return {
        headline: "Delete the login account",
        changes: ["The sign-in account is removed permanently.", "All sessions end."],
        unchanged: ["The HR record and the audit trail are retained for inspection."],
        reversible: false,
        ...(target.isOwner ? { blocked: "An Owner account cannot be deleted." } : {}),
      };
    case "assign_owner":
      return {
        headline: "Grant the Owner role",
        changes: ["Full platform authority across every property."],
        unchanged: ["Commercial approval authority, which is configured separately."],
        reversible: true,
      };
    case "remove_owner":
      return {
        headline: "Remove the Owner role",
        changes: ["Platform-wide authority is withdrawn."],
        unchanged: ["Other roles already assigned to this person."],
        reversible: true,
        ...(target.account_status === "active" ? {} : {}),
      };
    default:
      return {
        headline: "Confirm this change",
        changes: ["The change is recorded in the audit trail with your name and the time."],
        unchanged: [],
        reversible: true,
      };
  }
}
