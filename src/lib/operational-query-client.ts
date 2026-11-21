import {QueryClient} from '@tanstack/react-query';

/** A visible operational screen must recover missed remote changes without a socket.
 * Explicit per-query polling takes precedence. Read-only operational roots only:
 * simulations, signed links, account credentials and one-shot actions are excluded.
 */
export const OPERATIONAL_REFRESH_ROOTS = new Set([
 'active-approval-ids','approval-authority','approval-requests','audit-trail','bank-reconciliation','bank-transfer-queue','bar','canonical-state','cash','commitments','configuration','courier-jobs','credit',
 'crm-credit-line','crm-digital-summary','crm-metrics','dashboard-activity','dashboard-metrics','dashboard-my-tasks','dashboard-team-tasks','delivery','delivery-department','delivery-live','department-workload',
 'events','finance','finance-posting','financial-lifecycle','financial-states','fnb','folio-projection','folio-trace','front-office-department','go-live',
 'guest-bill','guest-booking-position','guest-laundry-mine','guest-laundry-offering','guest-menu','guest-menu-modifiers','guest-my-stays','guest-payment-availability','guest-requests','guest-reservations','guest-stay','guest-tracking',
 'housekeeping-department','hr-department','inventory','item-group-item-counts','kitchen','laundry-department','main-kitchen','maintenance-dept','minibar','my-work','neo-facts','neo-intelligence','neo-outbox-failures','neo-outbox-health','notification-history','notifications-unread','operational-stations','ops','outbound-release-status',
 'partner-credit-invoices','pastry','payment-audit-trail','payment-lifecycle','payment-readiness','payment-register','pms','pos','procurement','procurement-department','production-display-sessions','reconciliation','rider','sales-events','shared-production-display','staff-transport','staff-transport-candidates','station-stock','station-workload','stay-board','stock-needs','stock-transfers','stores-department','tasks','tasks-trend','transport-products','transport-requests','workforce'
]);
export function operationalRefreshInterval(query: {queryKey: readonly unknown[]}): number | false {
 return OPERATIONAL_REFRESH_ROOTS.has(String(query.queryKey[0])) ? 60_000 : false;
}
export function createOperationalQueryClient() {
 return new QueryClient({defaultOptions:{queries:{refetchInterval:operationalRefreshInterval,refetchIntervalInBackground:false}}});
}
