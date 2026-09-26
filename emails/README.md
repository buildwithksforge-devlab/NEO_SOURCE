# NEØ email templates

## `auth/confirm-signup.html` / `auth/confirm-signup.txt`

Branded sign-up confirmation ("verify your email") template.

### Status — application side COMPLETE, delivery NOT LIVE

Every account-creation path now supplies personalised metadata through
`src/lib/auth-email-metadata.ts`, and admins can inspect readiness at
**Settings → Integrations → Email delivery readiness** (`/admin/email-delivery`),
which never reports "live" or "sent" without a recorded provider and domain.

This workspace has **no verified email sending domain**, so the hosted auth
email template cannot be customised programmatically from this repository. The
template above is production-ready and must be pasted once into the project's
auth email configuration:

1. Set up an email sending domain for the project (Cloud → Emails).
2. Paste `auth/confirm-signup.html` into the **Confirm signup** template.
3. Keep `auth/confirm-signup.txt` as the plain-text alternative.

Until that step is done, the platform default confirmation email is sent.

### Template variables

| Variable | Source | Required |
| --- | --- | --- |
| `.ConfirmationURL` | Supabase auth (magic confirmation link) | yes |
| `.Data.full_name` | `raw_user_meta_data.full_name` set at sign-up | optional — greeting falls back to "Welcome to NEØ." |
| `.Data.organisation_name` | invite metadata | optional — block omitted when absent |
| `.Data.role_title` | invite metadata (role name, falls back to job title) | optional |
| `.Data.property_name` | invite metadata (branch/property name) | optional |
| `.Data.invited_by_name` | invite metadata (inviter display name) | optional |
| `.Data.account_type` | `staff` / `customer` / `owner` | optional |

No sensitive tenant data (IDs, keys, contact details) is exposed in the email.

### Design contract

- Full NEØ wordmark artwork (never the standalone glyph), with `alt="NEØ"`.
- Midnight-navy masthead, ivory body, turquoise CTA, champagne-gold sign-off.
- Table-based responsive layout, inline CSS only, 560px max width.
- Single primary CTA plus a raw-link fallback and a security note.
