# NEØ event ownership source repair

Original queue: NEO-BKL-F04, F05 and F07. No new feature or backlog item was added.

The requirement capture path allowed an optional configured department, while confirmation copied that value directly to a central task. BEO publication could also select no department. The new code-only guard resolves an unambiguous active department from existing configuration, prefers a matching property department over shared configuration, and refuses missing or ambiguous ownership. Explicit departments must be active and belong to the event property or shared workspace configuration.

Linked tasks must have the same organization, property and department. This makes the existing confirmation transaction roll back instead of persisting an ownerless or wrongly linked task. No existing requirement, task, assignee or payment is rewritten during installation. Legacy requirements need explicit review/correction before confirmation; no automatic history cleanup is included.

Validation: **21 isolated PostgreSQL-compatible checks passed**. They exercise the actual existing confirmation SQL for successful task creation, failure rollback and idempotent replay, plus property/shared selection, ambiguity, inactive/cross-property/cross-workspace rejection, linked task consistency, private helper privileges and installation-repeat refusal. The confirmation definition remains unchanged.

This is a local installation candidate, not an installed operational repair. SQL 85 installs the guard; SQL 86 is the later read-only installation check. Neither was run against the hotel database. Do not blanket-push migrations.

F04's ownership source repair is ready for controlled deployment and acceptance checks. F05/F07 remain partial: complete department acknowledgment, assignee responsibility and operational/accounting handoffs are not proven by this guard. General non-event task assignment under L05 is still open.

