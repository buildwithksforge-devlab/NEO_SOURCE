# Stale-view and disconnected-flow audit

1048 source files scanned; 725 query hooks, 646 mutation hooks and 477 refresh sites inventoried.

This is a candidate inventory, not a claim that every flagged item is broken or that all runtime issues have been found. Shared helpers, optimistic updates, polling and server actions need workflow review.

Confirmed payment connections repaired in the current candidate bundle: reservation/folio/payment/till refreshes and staff/organization-specific register caching. Existing deployed fixes remain separately recorded.

| Query root | Queries | Explicit refresh sites | Review |
|---|---:|---:|---|
| (dynamic) | 107 | 44 | Dynamic key requires manual review |
| access-matrix-departments | 1 | 0 | No explicit refresh root found; investigate |
| access-matrix-individual-overrides | 1 | 0 | No explicit refresh root found; investigate |
| access-matrix-role-permissions | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| active-approval-ids | 1 | 0 | No explicit refresh root found; investigate |
| ai-provider-settings | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| ai-simulation | 1 | 0 | No explicit refresh root found; investigate |
| ai-simulator-staff | 1 | 0 | No explicit refresh root found; investigate |
| approval-authority | 1 | 0 | No explicit refresh root found; investigate |
| approval-requests | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| approval-routing-policies | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| audit-trail | 1 | 0 | No explicit refresh root found; investigate |
| automation | 2 | 1 | Refresh site exists; workflow linkage still requires review |
| avatar-url | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| bank-reconciliation | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| bank-transfer-queue | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| bar | 6 | 1 | Refresh site exists; workflow linkage still requires review |
| branches | 3 | 1 | Refresh site exists; workflow linkage still requires review |
| canonical-state | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| cash | 7 | 1 | Refresh site exists; workflow linkage still requires review |
| command-records | 1 | 0 | No explicit refresh root found; investigate |
| commitments | 1 | 0 | No explicit refresh root found; investigate |
| config-collection | 1 | 4 | Refresh site exists; workflow linkage still requires review |
| config-collection-lookups | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| configuration | 1 | 0 | No explicit refresh root found; investigate |
| courier-connection | 1 | 0 | No explicit refresh root found; investigate |
| courier-jobs | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| credit | 3 | 0 | No explicit refresh root found; investigate |
| crm | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| crm-child | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-communications | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-corporate | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-credit-line | 1 | 0 | No explicit refresh root found; investigate |
| crm-customer | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-customers | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-digital-summary | 1 | 0 | No explicit refresh root found; investigate |
| crm-duplicates | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-feedback | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-loyalty-accounts | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-loyalty-program | 1 | 0 | No explicit refresh root found; investigate |
| crm-metrics | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| crm-segments | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| dashboard-activity | 1 | 0 | No explicit refresh root found; investigate |
| dashboard-metrics | 1 | 0 | No explicit refresh root found; investigate |
| dashboard-my-tasks | 1 | 0 | No explicit refresh root found; investigate |
| dashboard-scope-branches | 1 | 0 | No explicit refresh root found; investigate |
| dashboard-team-tasks | 1 | 0 | No explicit refresh root found; investigate |
| delivery | 42 | 9 | Refresh site exists; workflow linkage still requires review |
| delivery-department | 6 | 1 | Refresh site exists; workflow linkage still requires review |
| delivery-live | 1 | 0 | No explicit refresh root found; investigate |
| department-workload | 1 | 0 | No explicit refresh root found; investigate |
| departments | 2 | 3 | Refresh site exists; workflow linkage still requires review |
| device-admin-staff-pins | 1 | 0 | No explicit refresh root found; investigate |
| device-authorisations | 1 | 0 | No explicit refresh root found; investigate |
| email-provider-connections | 3 | 0 | No explicit refresh root found; investigate |
| etims-settings | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| etims-submissions-admin | 1 | 0 | No explicit refresh root found; investigate |
| events | 15 | 3 | Refresh site exists; workflow linkage still requires review |
| finance | 22 | 17 | Refresh site exists; workflow linkage still requires review |
| finance-posting | 9 | 1 | Refresh site exists; workflow linkage still requires review |
| financial-lifecycle | 1 | 0 | No explicit refresh root found; investigate |
| financial-states | 1 | 0 | No explicit refresh root found; investigate |
| fnb | 3 | 5 | Refresh site exists; workflow linkage still requires review |
| folio-projection | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| folio-trace | 1 | 0 | No explicit refresh root found; investigate |
| front-office-department | 4 | 1 | Refresh site exists; workflow linkage still requires review |
| go-live | 2 | 0 | No explicit refresh root found; investigate |
| guest | 2 | 0 | No explicit refresh root found; investigate |
| guest-addresses | 1 | 0 | No explicit refresh root found; investigate |
| guest-bill | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| guest-booking-position | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| guest-cart | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| guest-documents | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| guest-favourites | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| guest-laundry-mine | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| guest-laundry-offering | 1 | 0 | No explicit refresh root found; investigate |
| guest-menu | 1 | 0 | No explicit refresh root found; investigate |
| guest-menu-modifiers | 1 | 0 | No explicit refresh root found; investigate |
| guest-my-hotels | 1 | 0 | No explicit refresh root found; investigate |
| guest-my-stays | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| guest-payment-availability | 1 | 0 | No explicit refresh root found; investigate |
| guest-profile | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| guest-quote | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| guest-requests | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| guest-reservations | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| guest-room-offers | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| guest-stay | 1 | 0 | No explicit refresh root found; investigate |
| guest-tracking | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| hotel-partner-inbox | 1 | 0 | No explicit refresh root found; investigate |
| hotel-partner-threads | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| housekeeping-department | 3 | 1 | Refresh site exists; workflow linkage still requires review |
| hr | 20 | 12 | Refresh site exists; workflow linkage still requires review |
| hr-department | 6 | 1 | Refresh site exists; workflow linkage still requires review |
| integrity | 6 | 4 | Refresh site exists; workflow linkage still requires review |
| inventory | 20 | 17 | Refresh site exists; workflow linkage still requires review |
| item-group-categories | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| item-group-item-counts | 1 | 0 | No explicit refresh root found; investigate |
| item-groups | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| kitchen | 42 | 60 | Refresh site exists; workflow linkage still requires review |
| kpi-definitions | 1 | 0 | No explicit refresh root found; investigate |
| laundry-department | 7 | 3 | Refresh site exists; workflow linkage still requires review |
| main-kitchen | 5 | 1 | Refresh site exists; workflow linkage still requires review |
| maintenance-dept | 11 | 3 | Refresh site exists; workflow linkage still requires review |
| marketing-department | 4 | 1 | Refresh site exists; workflow linkage still requires review |
| menu-image-url | 1 | 0 | No explicit refresh root found; investigate |
| minibar | 3 | 1 | Refresh site exists; workflow linkage still requires review |
| mpesa-collection-status | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| mpesa-failed-callbacks | 1 | 0 | No explicit refresh root found; investigate |
| mpesa-settings | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| mpesa-transaction | 1 | 0 | No explicit refresh root found; investigate |
| mpesa-transactions | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| my-dashboards | 1 | 0 | No explicit refresh root found; investigate |
| my-department | 1 | 0 | No explicit refresh root found; investigate |
| my-production-pin | 1 | 0 | No explicit refresh root found; investigate |
| my-work | 1 | 0 | No explicit refresh root found; investigate |
| my-workspaces | 1 | 0 | No explicit refresh root found; investigate |
| neo-experience-studio | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| neo-facts | 4 | 1 | Refresh site exists; workflow linkage still requires review |
| neo-front-door | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| neo-front-door-destinations | 1 | 0 | No explicit refresh root found; investigate |
| neo-intelligence | 1 | 0 | No explicit refresh root found; investigate |
| neo-my-contexts | 1 | 0 | No explicit refresh root found; investigate |
| neo-my-entrances | 1 | 0 | No explicit refresh root found; investigate |
| neo-outbox-failures | 1 | 0 | No explicit refresh root found; investigate |
| neo-outbox-health | 1 | 0 | No explicit refresh root found; investigate |
| neo-partner-context | 1 | 0 | No explicit refresh root found; investigate |
| neo-partner-records | 1 | 0 | No explicit refresh root found; investigate |
| neo-partner-session | 1 | 0 | No explicit refresh root found; investigate |
| neo-platform-console | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| neo-property-doors | 1 | 0 | No explicit refresh root found; investigate |
| neo-property-listing-status | 1 | 0 | No explicit refresh root found; investigate |
| neo-public-experience | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| neo-traffic-summary | 1 | 0 | No explicit refresh root found; investigate |
| neo-visitor-property | 2 | 0 | No explicit refresh root found; investigate |
| notification-history | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| notification-preferences | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| notifications-unread | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| operational-stations | 1 | 0 | No explicit refresh root found; investigate |
| ops | 36 | 35 | Refresh site exists; workflow linkage still requires review |
| outbound-release-status | 1 | 0 | No explicit refresh root found; investigate |
| packages | 4 | 1 | Refresh site exists; workflow linkage still requires review |
| partner-access-corporates | 1 | 0 | No explicit refresh root found; investigate |
| partner-access-list | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| partner-access-suppliers | 1 | 0 | No explicit refresh root found; investigate |
| partner-billing-list | 1 | 0 | No explicit refresh root found; investigate |
| partner-credit-invoices | 1 | 0 | No explicit refresh root found; investigate |
| partner-threads | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| pastry | 7 | 1 | Refresh site exists; workflow linkage still requires review |
| payment-audit-trail | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| payment-intent | 1 | 0 | No explicit refresh root found; investigate |
| payment-lifecycle | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| payment-readiness | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| payment-register | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| pending-role-decisions | 1 | 0 | No explicit refresh root found; investigate |
| permission-catalogue | 1 | 0 | No explicit refresh root found; investigate |
| permissions | 1 | 0 | No explicit refresh root found; investigate |
| pms | 29 | 16 | Refresh site exists; workflow linkage still requires review |
| pos | 30 | 46 | Refresh site exists; workflow linkage still requires review |
| preview-role-accounts | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| preview-role-dashboards | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| preview-role-permission-counts | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| preview-role-permissions | 1 | 0 | No explicit refresh root found; investigate |
| preview-roles | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| procurement | 20 | 10 | Refresh site exists; workflow linkage still requires review |
| procurement-department | 7 | 1 | Refresh site exists; workflow linkage still requires review |
| production-display-sessions | 1 | 0 | No explicit refresh root found; investigate |
| profiles | 2 | 6 | Refresh site exists; workflow linkage still requires review |
| provider-credential-summary | 1 | 0 | No explicit refresh root found; investigate |
| public-delivery | 1 | 9 | Refresh site exists; workflow linkage still requires review |
| public-experiences | 1 | 0 | No explicit refresh root found; investigate |
| public-rooms | 1 | 0 | No explicit refresh root found; investigate |
| publish-branches | 1 | 0 | No explicit refresh root found; investigate |
| publish-delivery-facts | 1 | 0 | No explicit refresh root found; investigate |
| publish-organization | 1 | 0 | No explicit refresh root found; investigate |
| rates | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| reconciliation | 2 | 4 | Refresh site exists; workflow linkage still requires review |
| reporting-candidates | 2 | 1 | Refresh site exists; workflow linkage still requires review |
| restricted-actions | 1 | 0 | No explicit refresh root found; investigate |
| rider | 2 | 1 | Refresh site exists; workflow linkage still requires review |
| role-assignment-history | 1 | 0 | No explicit refresh root found; investigate |
| role-catalogue | 1 | 0 | No explicit refresh root found; investigate |
| role-catalogue-scope | 1 | 0 | No explicit refresh root found; investigate |
| role-members | 1 | 0 | No explicit refresh root found; investigate |
| role-migration-items | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| role-migration-preflight | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| role-migration-runs | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| role-model-adoption | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| role-permissions | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| role-reconciliation | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| role-template-diff | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| role-template-status | 1 | 0 | No explicit refresh root found; investigate |
| roles | 2 | 5 | Refresh site exists; workflow linkage still requires review |
| sales-events | 9 | 1 | Refresh site exists; workflow linkage still requires review |
| scope | 3 | 0 | No explicit refresh root found; investigate |
| security | 9 | 1 | Refresh site exists; workflow linkage still requires review |
| self-approval-exceptions | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| settings-status | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| shared-production-display | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| simulate-access | 1 | 0 | No explicit refresh root found; investigate |
| simulation-environments | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| simulation-results | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| simulation-runs | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| staff-security-metadata | 2 | 0 | No explicit refresh root found; investigate |
| staff-transport | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| staff-transport-candidates | 1 | 0 | No explicit refresh root found; investigate |
| station-stock | 4 | 0 | No explicit refresh root found; investigate |
| station-workload | 1 | 0 | No explicit refresh root found; investigate |
| stay-board | 1 | 0 | No explicit refresh root found; investigate |
| stock-needs | 1 | 2 | Refresh site exists; workflow linkage still requires review |
| stock-transfers | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| stores-department | 7 | 4 | Refresh site exists; workflow linkage still requires review |
| system-settings | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| system-settings-history | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| tasks | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| tasks-trend | 1 | 0 | No explicit refresh root found; investigate |
| transport-products | 1 | 0 | No explicit refresh root found; investigate |
| transport-requests | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| user-audit | 1 | 0 | No explicit refresh root found; investigate |
| user-permissions | 1 | 0 | No explicit refresh root found; investigate |
| user-roles | 1 | 3 | Refresh site exists; workflow linkage still requires review |
| user-stations | 1 | 1 | Refresh site exists; workflow linkage still requires review |
| visibility-subordinates | 1 | 0 | No explicit refresh root found; investigate |
| worker-push-configuration | 1 | 0 | No explicit refresh root found; investigate |
| workforce | 2 | 0 | No explicit refresh root found; investigate |

Candidate detail and file/line locations are in the JSON inventory. Counts: 100 roots without an explicit refresh site, 219 query keys without a visible identity marker, 5 mutation hooks without direct success/settled handlers, 7 handlers without an obvious refresh call. These categories overlap and must not be added to the 106 issue count.
