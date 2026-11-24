import {existsSync,readFileSync,writeFileSync} from "node:fs";

// The catalogue is the current execution plan. Older issue records retain their
// original evidence/status and are linked for traceability, not re-certified.
const chain=(id,priority,name,roles,flow,finish,next,dependencies=[])=>({
 id,priority,name,roles,flow,finish,next,dependencies,status:"OPEN",evidence:[],
});
const chains=[
 chain("WF01","P0","Organisation, property and data isolation","Owner / administrator / scoped staff",
  "Organisation setup → property configuration → role scope → property switch → reads/writes/documents/reports",
  "Existing and new organisations work without fixed hotel IDs; foreign property/organisation access is denied in UI, RPC, storage and reports.",
  "Retain the 23 installed shared routines; verify actual staff property switching and hidden-record refusal."),
 chain("WF02","P0","Staff identity, Users, roles, PIN and devices","Administrator / supervisor / employee",
  "Invite/create → approve/access → role assignment → sign-in/PIN/device pairing → recovery → suspend/revoke",
  "The intended person has exactly their permitted scope; recovery email really arrives; privileged actions audit; revoked access stops working.",
  "Verify the supported privileged Users executor and role/audit parity; complete live recovery and paired-device checks.",["WF01"]),
 chain("WF03","P0","Shared business configuration and pricing","Property administrator / Finance",
  "Currency/timezone/business date → tax/service/discount/rate/meal policy → calculation → bill → settlement → journal/report",
  "Configured components propagate once with documented inclusion/exclusion, rounding, units and dates; optional charges need no fixed-name assumptions.",
  "Inventory actual policies and verify inclusive tax, new charge components, exemptions and rate changes using saved examples.",["WF01","WF02"]),
 chain("WF04","P1","Purchase request through approved LPO","Department requester / procurement / approver",
  "Need/requisition → RFQ → supplier quotation → comparison/selection → approval → numbered LPO → supplier dispatch",
  "Approved purchase, supplier, quantities/prices, approvals and actual outbound delivery evidence form one retrievable chain.",
  "Complete real role handoffs and supplier communication; retain the original approved document and delivery reference.",["WF03"]),
 chain("WF05","P1","Delivery, blind receiving and GRN","Receiver / independent reviewer / stock poster / Finance",
  "Supplier delivery note/file → blind count → reconciliation → accepted/rejected/short → approval → GRN → stock/batch/cost → accrual",
  "Only accepted quantities post; repeated/partial deliveries trace to original PO lines; GRN, lots, stock value and accrual agree; finance recovery does not repost stock.",
  "Verify installed guards and both authority paths; reconcile a real delivery and archive the supplier original.",["WF04","WF07","WF08","WF23"]),
 chain("WF06","P1","Supplier invoice, payable and payment","AP clerk / Finance approver / payer",
  "Supplier invoice → LPO/GRN/price/tax match → variance approval/rejection → payable/journal → schedule → release → settlement/remittance",
  "Original purchase, accepted GRN, invoice, aging, payment and balanced journal agree; duplicate invoice/payment and incorrect journal reuse refuse.",
  "Verify AP dashboard/aging, approval and payment stages with source-linked journals and remittance output.",["WF05","WF23"]),
 chain("WF07","P1","Stores, station mapping and transfers","Stores / department issuer / receiving department",
  "Owned item/base unit → physical store → departmental/station mapping → requisition/approval → dispatch → in-transit → receipt/return/cancel",
  "Actual source/destination and authority are correct; base quantities, lots, saved cost and in-transit valuation reconcile without invented mappings.",
  "Obtain explicit-station repair postcheck, resolve remaining actual store choices, then verify transfer handoff and reports.",["WF03"]),
 chain("WF08","P1","Stock counts, adjustments, lots and expiry","Counter / reviewer / stock controller",
  "Physical count → variance → independent approval → adjustment → lot/expiry coverage → valuation/report",
  "Signed movements and FEFO allocations reconcile to balances; expired/blocked-lot policy is explicit; no silent negative stock or historical cost rewrite.",
  "Resolve existing batch/cost discrepancies, expired-lot policy, configured conversions and report parity.",["WF03","WF07"]),
 chain("WF09","P1","Menu, recipes, production and consumption","Kitchen / Bar / Coffee / Pastry / stock controller",
  "Owned stock/menu binding → manual/import draft → review/activation → units/yield/sub-recipes → produce/sell → consume → waste/return",
  "One intended active version uses owned property stock/store; direct-sale and batch units/costs agree; actual deductions/returns happen once with source IDs.",
  "Confirm 21-recipe/20-menu cleanup; verify staff save/import/activation and real station depletion; resolve skipped consumption coverage.",["WF07","WF08"]),
 chain("WF10","P1","POS order and production handoff","Waiter / cashier / production station / supervisor",
  "Table/channel order → item/modifiers → send → scoped station ticket/display → accept/prepare/ready → serve → approved void/return",
  "Prices/options persist atomically; correct department receives each item; paid/pending-protected lines cannot drift; lost-response item retry cannot duplicate a sale.",
  "Verify all station channels, reconnect/handoffs, item-attempt identity and authentic recovery of the historical KES51 sale.",["WF09"]),
 chain("WF11","P0","POS collections and settlement","Cashier / cashier supervisor / Finance / provider",
  "Amount due → cash/card/bank/M-Pesa/QR attempt → pending/confirmation/callback → receipt → allocations → journal → close/refund",
  "Only verified receipts reduce debt once; split tenders, cash change, provider uncertainty, late callbacks and recovery retain the original attempt and source.",
  "Trace real existing attempts; verify installed start/dispatch and recovery contracts, partial tenders, pending card/QR and cashier close.",["WF03","WF10","WF23"]),
 chain("WF12","P1","Delivery, rider and remittance","Guest / dispatcher / production / rider / cashier",
  "Guest order → quote/payment intent → preparation → rider assignment/dispatch → delivery/proof → cash handover/remittance → settlement/refund",
  "Guest, dispatcher and rider see the same scoped order; delivery status does not invent payment; collected cash and remittance/journal agree.",
  "Verify guest-to-rider handoffs, failed/cancelled deliveries, collected-cash reconciliation and app recovery.",["WF10","WF11","WF34"]),
 chain("WF13","P0","Availability, quote, reservation and deposit","Reservations / guest / Finance",
  "Dates/availability → rate/room/meal/tax quote → reservation/confirmation → deposit request → confirmed receipt → held liability/history",
  "Nights, quote, deposit requirement and confirmed money reconcile; availability/property/date checks hold; pending money is separate and retry is once-only.",
  "Run corrected existing-ID money inspection and trace actual bookings, receipts, pending requests and quote differences.",["WF03","WF23"]),
 chain("WF14","P0","Arrival and deposit application","Front desk / cashier / supervisor",
  "Eligible reservation → identity/deposit gate → room assignment → check-in → stay/folio → one deposit application → first accommodation charge",
  "Reservation, stay, room and folio agree; held deposit transfers without a second receipt/revenue entry; first-night and original liability journals reconcile.",
  "Verify one real arrival and the original deposit/payment/application IDs, including waivers, denied arrival and rollback.",["WF13"]),
 chain("WF15","P0","In-house stay, room move and night audit","Front desk / night auditor / Finance",
  "Assigned stay → room/type/rate changes → consecutive business-day accommodation → taxes/service → adjustments → audit close",
  "No missing/duplicate nights or double quote charges; room moves preserve ownership, date/rate history and balances; audit refuses incomplete financial evidence.",
  "Verify installed nightly/pricing guards and actual consecutive days, adjustments, future-date refusal and business-date reporting.",["WF14","WF23"]),
 chain("WF16","P1","Minibar, room service, laundry and guest services","Housekeeping / station staff / laundry / front desk",
  "Service intake/consumption → correct current stay/room/folio/store → fulfilment/stock → charge → delivery/return → history/journal",
  "Each operational source is billed once with correct quantities, tax/service, stock and durable historical identity; non-folio settlement is accounted for.",
  "Verify installed durable Minibar with staff, actual store designation, room-service transfers and laundry intake/processing/delivery/billing.",["WF09","WF15","WF23"]),
 chain("WF17","P0","Corporate/group credit and folio allocation","Front desk / corporate accounts / credit controller / Finance",
  "Corporate/group authority → room/master/guest folios → routing/transfers → deposits/payments → allocation → invoice/credit account → collection",
  "Every included folio and shared master reconciles separately; credit cannot hide another folio's debt; one receipt cannot be allocated twice.",
  "Complete shared-master/split-allocation behavior and actual corporate-credit settlement; retain installed multi-folio checkout.",["WF13","WF23"]),
 chain("WF18","P0","Departure, refunds and room release","Front desk / authorized override/refund approver / cashier",
  "Review every folio → settle/refund/authorized credit departure → checkout → release assignments → vacant dirty → issued final history",
  "Each debt/credit has evidence and authority; room transition is saved; maintenance holds survive; repeated checkout/refund cannot duplicate effects.",
  "Reconcile actual reservation/POS room-charge money, including prior POS payments, then verify departure and refund journal evidence.",["WF15","WF16","WF17","WF23"]),
 chain("WF19","P1","Housekeeping, inspection and sellability","Housekeeping attendant / inspector / front desk",
  "Vacant dirty/in-house task → assign → clean → linen/amenity use → independent inspection → sellable availability",
  "Dirty, uninspected or maintenance-held rooms cannot be sold early; room axes, tasks, consumption and front-desk availability agree.",
  "Verify real departure-to-clean/inspect handoff, blocked-room refusal and inspector permissions.",["WF18","WF20"]),
 chain("WF20","P1","Assets, maintenance and room holds","Requester / engineer / independent verifier / stores",
  "Fault/asset/PM → work order/assignment → hold → parts/work log → completion → independent verification → closure → dirty-room handback",
  "Parts/cost/asset history persist; concurrent work orders retain holds; technician cannot self-release an unverified room; cleaning remains required.",
  "Run actual repair/hold/verification and competing-work-order regressions; verify asset history and departmental stock effects.",["WF02","WF07"]),
 chain("WF21","P1","Events and departmental fulfilment","Sales / event coordinator / production / Finance",
  "Enquiry → quotation/version → contract/approval → deposit → event booking/BEO → departmental tasks/stock → delivery → final invoice/payment/cancel",
  "Approved event version drives BEO, quantities, assignments and billing; existing invoices are reused; deposits and cancellation/refund obligations reconcile.",
  "Verify real event handoffs, approved versions, final billing and quotation/contract/confirmation/BEO retrieval.",["WF09","WF11","WF23","WF24"]),
 chain("WF22","P1","HR, attendance, scheduling and payroll","HR / employee / supervisor / payroll / Finance",
  "Employee/contract → roster → attendance/leave/approval → payroll inputs → review/release → payout/journal → payslip/history",
  "Authorized employee/period figures reconcile; release gates and payroll privacy hold; staff letters/contracts/schedules and payslips retain source identity.",
  "Inventory actual HR/payroll scenarios, verify approval/release/access and money/document parity with the existing configured payroll process.",["WF02","WF23","WF24"]),
 chain("WF23","P0","Finance, receivables, cashbook and close","Finance clerk / approver / accountant / night auditor",
  "Operational source → classification/recognition → journal → register/cashbook/AR/AP → reconciliation → shift/business-date/period close → reversal",
  "Revenue, deposits, tax/service/tips, refunds, receivables and liabilities are classified correctly; posted journals balance and reconcile to original records/reports.",
  "Reconcile real operational source IDs and accounts; verify period/shift close, original journal identity and controlled reversals.",["WF03"]),
 chain("WF24","P1","Every required document and lifecycle","Issuing department / Finance / authorized recipient",
  "Approved saved source/version → preview → numbered issue → PDF/download → print/send → retrieval after status change → reprint/supersession",
  "Correct identity/logo/fields/currency/timezone/amounts and access; all required outputs exist or use an explicit uploaded original; reprint never creates a transaction.",
  "Complete the document register below, alternative/missing generators, long/multipage cases and actual source-to-render comparison.",["WF03"]),
 chain("WF25","P1","Printer and production-output routing","Device administrator / cashier / production station",
  "Document/ticket → browser/OS or paired agent → scoped printer/queue → transport acknowledgement → correct paper → offline/retry/reprint",
  "User-reported working printer is preserved; each required receipt/A4/station output has correct paper/layout and backup behavior; acknowledgement is distinct from paper.",
  "Extend the successful physical test to required document types, Kitchen/Bar/Coffee/Pastry routes and safe uncertain-outcome/reprint handling.",["WF10","WF24"]),
 chain("WF26","P1","Approvals, tasks, communications and automation","Requester / delegated approver / assignee / communications owner",
  "Business trigger → approval/task/rule → correct recipient/scope → provider dispatch → delivery/failure/retry → audit/history/escalation",
  "No false sent/success labels, duplicate outbound action or unauthorized approval; correct record links, provider references and human handoff persist.",
  "Verify approved runtime paths, actual email/SMS/notification delivery, scheduling/retry/timezone and automation-to-business-action authority.",["WF02","WF03"]),
 chain("WF27","P1","Public guest discovery and self-service","Guest / reservations / front desk",
  "Property listing → room/menu/event discovery → booking/order → deposit/payment → confirmation → stay requests/folio/documents → departure feedback",
  "Guest sees correct property, quote and saved work across inner routes; private staff/customer data remains protected and failed/expired sessions recover.",
  "Walk the guest entry and inner flows on the latest build, including configured photography, real source links and mobile/back navigation.",["WF12","WF13","WF16","WF34"]),
 chain("WF28","P1","Security, visitors, incidents and handover","Security officer / supervisor / authorized operations staff",
  "Visitor/vehicle/incident/lost-property intake → assignment/patrol/escalation → authorized closure/return → shift handover → audit/report",
  "Identity/privacy and property limits hold; chain of custody, accountable handover and incident evidence remain linked after closure.",
  "Inventory and verify existing security workflows and their operations/task/stock handoffs under actual roles.",["WF02","WF26"]),
 chain("WF29","P1","Reports, dashboards, analytics and AI answers","Management / department manager / Finance",
  "Saved operational/financial source → scoped facts → period/filter/aggregation → dashboard/report/AI explanation → export → drill-back",
  "Figures, definitions, currency/timezone and filters agree with source/ledger; AI output cites available records and does not fabricate completion.",
  "Reconcile financial and operational reports plus every management exporter; test denied scope, stale refresh and reproducible drill-back.",["WF23","WF24"]),
 chain("WF30","P0","Release, runtime and operational reliability","Release operator / administrator / support",
  "Reviewed source → installed-contract comparison → checks/build/artifact → deploy → live identity → monitoring/live refresh → backup/restore/recovery",
  "App/SQL/agent versions are compatible; no unknown newer repair is overwritten; secrets stay private; real runtime, reconnect, performance and recovery are evidenced.",
  "Retain the verified 19 November preview/SQL milestone; finish original Horizon publication parity, live runtime gaps and rollback/recovery acceptance."),
 chain("WF31","P2","CRM, sales, marketing and loyalty","Sales / marketing / customer-service staff",
  "Customer/lead identity → consent/preferences → enquiry/opportunity → offer/campaign/loyalty → booking/sale → delivery/outcome → account history",
  "Deduplicated scoped identity links the actual booking/sale; consent, eligibility, redemptions and provider outcomes persist without fabricated sends.",
  "Inventory configured CRM/loyalty/campaign paths and verify real source linkage, permissions, opt-out and outcome reporting.",["WF26","WF29"]),
 chain("WF32","P2","Transport, fleet and operational handoffs","Dispatcher / driver / asset custodian / Finance",
  "Transport request → vehicle/driver availability → approval/assignment → trip/service/expenses → completion/handover → cost/asset/report",
  "Where configured, assignments, movement, expenses and asset history agree; unauthorized/double allocation and unsupported actions are explicit.",
  "Inventory implemented transport/fleet routes and required hotel use cases; repair or explicitly account for missing workflow steps.",["WF20","WF23","WF26"]),
 chain("WF33","P1","Supplier/partner account and external handoffs","Supplier/partner / procurement / account owner",
  "Invitation/access → scoped catalogue/quote/document → order/approval → fulfilment evidence → invoice/account/payment → support/history",
  "External users see only authorized owned records; supplier originals, acknowledgements and account balances connect to the internal purchase/finance chain.",
  "Walk existing partner/supplier routes and actual inbound/outbound handoffs; distinguish manual record keeping from delivered communication.",["WF04","WF06","WF26","WF34"]),
 chain("WF34","P1","All audience apps, displays and presentation","Guest / supplier / rider / employee / display operator",
  "Correct audience entry → sign-in/device/PWA → inner routes/actions → handoff/deep-link → loading/error/empty/offline → back/re-entry/session recovery",
  "Guest, partner, rider, staff and displays finish their intended tasks on mobile/desktop; navigation, accessibility, contrast and OS handoffs are coherent.",
  "Inventory all audience routes and visible actions, then verify functioning inner flows, device identity, public-data exposure and measured performance.",["WF01","WF02","WF30"]),
];

const commonChecks=[
 "Record lineage: trigger and every saved source/destination ID, organization/property, actor and status transition.",
 "Money/units/dates: configured pricing and components, inclusive/exclusive tax, discounts, service, deposits, pending money, rounding, currency, base units and business dates.",
 "Downstream effects: stock/lot/value, room/task/asset state, operational registers and balanced source-linked journals; mark a genuinely inapplicable effect N/A with a reason.",
 "Authority/isolation: real requester/approver/operator roles, organization/property/department/station boundaries and explicit denied cases.",
 "Failure/retry: validation, partial failure/rollback, duplicate clicks, concurrent actions, lost responses, callbacks, reconnect and replay retain the original attempt.",
 "Corrections/history: reject, cancel, void, transfer, return, refund, reversal and supersession follow policy and retain original records/audit.",
 "Outputs: relevant preview/PDF/download/send/print/reprint/retrieval and physical/provider proof; sending/queuing/transport/paper are distinct states.",
 "Installed/deployed acceptance: installed routine/permissions, app/agent build, actual role/browser/device, expected versus observed result and open exceptions.",
];
const documents=[
 "POS/customer receipt and corrected/reprint copy","Customer invoice, credit/refund document and account statement",
 "Reservation/booking confirmation and final guest folio","Corporate/group invoice, statement and routing evidence",
 "RFQ/quotation, approved LPO and supplier dispatch evidence","Supplier original delivery note/attachment, blind count/reconciliation record and posted GRN",
 "Supplier invoice/matching/variance decision, statement and remittance advice","Requisition, transfer/dispatch/receipt/return, count/adjustment/stock sheets",
 "Recipe/version/batch/production/waste/return and station preparation tickets","Event quotation, contract/signed original, confirmation, BEO and final bill",
 "Employment/HR letters/contracts, authorized staff records, roster and released payslip","Laundry/service/maintenance/task sheets and handover records",
 "Every management/Finance/department report exporter and filtered export",
];
const evidenceFields=["chain_id","step","case_or_issue_id","source_and_linked_record_ids","organisation_property_department_station","actor_and_role","source_commit_and_app_agent_build","installed_routine_hash_and_grants","expected_result","observed_result","before_after_money_stock_room_state","journal_and_document_provider_references","retry_failure_denial_evidence","verification_time","status_and_remaining_gap"];
const milestones=[
 {id:"M01",state:"INSTALLED_VERIFIED",scope:"23 shared workflow routines across the returned 28-organisation inspection; preserve 20 shared and 3 reviewed later definitions",source:"ACTIVE-EXECUTION-QUEUE.md: verified system-wide checkpoint"},
 {id:"M02",state:"INSTALLED_VERIFIED",scope:"Atomic recipe save/approval/history, authenticated execution allowed and anonymous denied; actual staff full-chain acceptance remains open",source:"ACTIVE-EXECUTION-QUEUE.md: recipe installation evidence"},
 {id:"M03",state:"INSTALLED_VERIFIED",scope:"19 November shared checkout and durable Minibar installation, including retry storage and guarded staff execution",source:"ACTIVE-EXECUTION-QUEUE.md: verified deployment checkpoint, 19 November"},
 {id:"M04",state:"DEPLOYED_VERIFIED",scope:"neo-preview build 25f97e90e69f9ae0; deployment/version evidence recorded; original Horizon publication separately unverified",source:"ACTIVE-EXECUTION-QUEUE.md: verified deployment checkpoint, 19 November"},
 {id:"M05",state:"USER_REPORTED_PHYSICAL_PASS",scope:"Kelvin's successful physical printer test; preserve that setup; other document/station layouts remain open",source:"ACTIVE-EXECUTION-QUEUE.md: verified deployment checkpoint, 19 November"},
];

function parseCsv(text){
 const rows=[];let row=[],field="",quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(field);field="";}
  else if(c==='\n'&&!quoted){row.push(field);if(row.some(Boolean))rows.push(row);row=[];field="";}
  else if(c!=='\r'||quoted)field+=c;
 }
 if(quoted)throw Error("Unterminated historical CSV field");
 if(field||row.length){row.push(field);rows.push(row);}
 const header=rows.shift().map(s=>s.replace(/^\uFEFF/,""));
 return rows.map(values=>Object.fromEntries(header.map((key,i)=>[key,values[i]??""])));
}
function linkIssue(id){
 if(id.startsWith("FIN-"))return ["WF03","WF11","WF23","WF24","WF29"];
 const match=id.match(/^NEO-BKL-([A-MR])(\d+)$/);if(!match)throw Error(`Unmapped historical issue ${id}`);
 const groups={A:["WF10","WF11"],B:["WF02","WF10","WF25","WF34"],C:["WF07","WF08","WF09"],D:["WF13","WF14","WF15","WF17","WF18"],E:["WF19"],F:["WF21","WF24"],G:["WF04","WF05","WF06","WF07"],H:["WF16"],I:["WF20"],J:["WF15","WF23","WF29"],K:["WF11","WF12"],L:["WF01","WF02","WF03","WF26","WF30","WF34"],M:["WF27","WF34"]};
 if(match[1]!=="R")return groups[match[1]];
 const special={1:["WF23","WF29"],2:["WF25"],3:["WF34"],4:["WF10","WF34"],5:["WF30"],6:["WF01"],7:["WF23"],8:["WF03","WF24"],9:["WF02","WF26"]};
 const linked=special[Number(match[2])];if(!linked)throw Error(`Unmapped supplemental issue ${id}`);return linked;
}
const original=parseCsv(readFileSync("docs/repair/NEO-106-EXECUTION-QUEUE-2026-11-07.csv","utf8"));
if(original.length!==106)throw Error(`Historical backlog changed: expected 106 records; found ${original.length}. Review coverage.`);
const legacy=original.map(r=>({id:r.issueId,chain_ids:linkIssue(r.issueId),historical_department:r.department,
 historical_status:r.currentStatus,historical_closed:r.closed,historical_next_action:r.nextAction,
 source:"NEO-106-EXECUTION-QUEUE-2026-11-07.csv"}));
const ids=new Set(chains.map(c=>c.id));
const taskPath="docs/repair/WORKFLOW-TASKS.json";
const taskLedger=existsSync(taskPath)?JSON.parse(readFileSync(taskPath,"utf8")):null;
if(taskLedger){
 if(!Array.isArray(taskLedger.tasks)||new Set(taskLedger.tasks.map(t=>t.id)).size!==taskLedger.tasks.length)throw Error("Invalid task ledger");
 if(!taskLedger.tasks.some(t=>t.id===taskLedger.active_task))throw Error("Active task is missing from ledger");
 for(const task of taskLedger.tasks)if(!task.chains?.length||task.chains.some(id=>!ids.has(id)))throw Error(`Task has an unknown workflow chain: ${task.id}`);
}
if(ids.size!==chains.length||new Set(legacy.map(i=>i.id)).size!==legacy.length)throw Error("Duplicate chain or historical issue ID");
for(const c of chains)for(const dependency of c.dependencies)if(!ids.has(dependency)||dependency===c.id)throw Error(`Invalid dependency ${c.id}: ${dependency}`);
for(const i of legacy)if(!i.chain_ids.length||i.chain_ids.some(id=>!ids.has(id)))throw Error(`Uncovered historical issue ${i.id}`);
function visit(id,path=[]){if(path.includes(id))throw Error(`Dependency cycle ${[...path,id].join(" -> ")}`);for(const dependency of chains.find(c=>c.id===id).dependencies)visit(dependency,[...path,id]);}
for(const c of chains)visit(c.id);
for(const c of chains)c.legacy_issue_ids=legacy.filter(i=>i.chain_ids.includes(c.id)).map(i=>i.id);
const result={updated:"2026-11-19",scope:"All existing/future organisations, departments, audience apps and cross-department workflows in the established system scope",overall_status:"OPEN",
 status_rule:"A milestone verifies only its stated scope. Every chain remains OPEN until applicable common checks and finish evidence pass. Historical statuses are preserved, not automatically recertified.",
 chains,execution_task_ledger:taskLedger,common_acceptance_checks:commonChecks,evidence_fields:evidenceFields,required_document_register:documents,verified_milestones:milestones,legacy_issue_mapping:legacy,
 coverage:{workflow_chains:chains.length,historical_issues:legacy.length,mapped_historical_issues:legacy.filter(i=>i.chain_ids.length).length,unmapped_historical_issues:0},
 execution_batches:[
 {id:"B01",work:"Preserve deployed/installed milestones; collect corrected reservation inspection and explicit station-store repair results",chains:["WF01","WF07","WF13","WF18","WF30"]},
 {id:"B02",work:"Resolve real money discrepancies and partial-payment room transfers, deposit/nightly/credit/refund evidence",chains:["WF03","WF11","WF13","WF14","WF15","WF17","WF18","WF23"]},
 {id:"B03",work:"Resolve physical store choices, historic ownership and recipe/import/consumption chains",chains:["WF07","WF08","WF09","WF10","WF16"]},
 {id:"B04",work:"Close supplier purchase/receiving/AP/communication/document evidence",chains:["WF04","WF05","WF06","WF24","WF26","WF33"]},
 {id:"B05",work:"Complete guest, delivery, events, housekeeping/maintenance and HR/operational handoffs",chains:["WF12","WF19","WF20","WF21","WF22","WF27","WF28","WF31","WF32"]},
 {id:"B06",work:"Complete Users/provider acceptance, all documents/station prints, apps/reports and final release/recovery evidence",chains:["WF02","WF24","WF25","WF26","WF29","WF30","WF34"]},
 ]};
const jsonPath="docs/repair/SYSTEM-WORKFLOW-QUEUE.json";
const output=JSON.stringify(result,null,2)+"\n";
const cells=s=>String(s).replaceAll("|","/").replaceAll("\n"," ");
const section=`<!-- SYSTEM-WORKFLOW-QUEUE:BEGIN -->
## Master workflow queue — 19 November

**This is the current execution index.** It covers all departments and audience apps in the established system scope. The dated checkpoints below supply evidence; older task statuses do not override newer verified milestones. The [machine-readable queue](SYSTEM-WORKFLOW-QUEUE.json) contains each chain's next action, dependencies, evidence fields and all historical issue links.

Coverage: **${chains.length} end-to-end chains; all ${legacy.length} original backlog items mapped; zero unmapped items.** This is a scope/traceability check, not a claim that every chain passed. Every chain currently remains OPEN for its outstanding work or live acceptance. Keep completed installation/deployment/printer milestones below completed within their verified scope.

### Verified foundation retained

These are the latest recorded milestones, with their original evidence retained in the dated checkpoints. They are not queued for redevelopment.

${milestones.map(m=>`- **${m.id} — ${m.state}:** ${m.scope}.`).join("\n")}

### Start here

1. Run the corrected existing-ID reservation inspection and collect the explicit station-store reconciliation result. Identify actual offending records; preserve working setup.
2. Resolve confirmed money differences and station/stock configuration, then complete the connected workflows below in dependency order.
3. Record source, installed and live evidence separately. Close individual steps only with their stated evidence, and close a chain only after all applicable common checks pass.

### Every chain must cover these checks

${commonChecks.map((item,i)=>`${i+1}. ${item}`).join("\n")}

### Complete workflow register

P0 protects money, access and rollout; P1 covers required operations; P2 covers the broader established product scope. A priority does not remove a chain from the completion queue. Role names are execution roles, not an assertion that a specific employee has been assigned.

| ID | Priority | Chain / responsible roles | End-to-end path | Finish evidence |
| --- | --- | --- | --- | --- |
${chains.map(c=>`| ${c.id} | ${c.priority} | **${cells(c.name)}** — ${cells(c.roles)} | ${cells(c.flow)} | ${cells(c.finish)} |`).join("\n")}

### Execution batches and next actions

${taskLedger?`Current scoped task: **${taskLedger.active_task}**. The [task execution ledger](WORKFLOW-TASKS.json) records its confirmed defect, finish checks, test results, installation state and remaining live evidence. Complete or checkpoint that scope before selecting the next independent task.`:""}

${result.execution_batches.map(b=>`- **${b.id}:** ${b.work}. Chains: ${b.chains.join(", ")}.`).join("\n")}

The exact immediate next action for every chain is in the JSON next field. Block only the dependent step when access/configuration/evidence is missing; continue other authorized work. Review unknown or missing product flows rather than silently classifying them as implemented. Record N/A only with a specific reason and agreed scope.

### Required document register — apply WF24/WF25 to each

${documents.map(d=>`- ${d}.`).join("\n")}

Identify the real generator or explicit uploaded-original path first. Confirm transaction identity, source status/version, mandatory fields, branding, currency/timezone, permissions, short/long/multipage cases and retrieval after status changes. Keep ordinary browser printing, automatic station output and external dispatch evidence distinct.

### Evidence and closure

For each step record: ${evidenceFields.map(f=>f.replaceAll("_"," ")).join("; ")}.

Use **OPEN → IN PROGRESS → LOCAL VERIFIED → INSTALLED/DEPLOYED VERIFIED → WORKFLOW VERIFIED** as applicable to that step. Configuration/data corrections require before/after source IDs and postcheck; deployment requires actual build/contract evidence; delivery/printing requires the actual provider/device outcome. A passing test or an installed function does not close the downstream workflow. Keep refund/return/cancellation and uncertainty cases in the same chain as the original operation.

The three focused completion gates remain **procurement/supplier/stock integrity**, **documents/physical outputs**, and **PMS/money/room lifecycle**. The broader system also requires the remaining app, HR, event, delivery, security, reporting and operational chains above. Do not mark the system complete while an applicable chain, historical issue or unresolved acceptance exception remains unaccounted for.

Historical traceability: [106-item evidence](NEO-106-EXECUTION-QUEUE-2026-11-07.csv), [launch follow-ups](NEO-LAUNCH-EXECUTION-QUEUE-2026-11-13.md), [product scope](PRODUCT-REPAIR-QUEUE-2026-11-14.md), [workflow code review](WORKFLOW-CODE-REVIEW-2026-11-14.md), [document/procurement/PMS inventory](PROCUREMENT-DOCUMENTS-PMS-ACCEPTANCE-2026-11-16.md). Current facts are reconciled in the newer checkpoints below; older dates are retained as history.
<!-- SYSTEM-WORKFLOW-QUEUE:END -->`;
const path="docs/repair/ACTIVE-EXECUTION-QUEUE.md";
let active=readFileSync(path,"utf8").replaceAll("\r\n","\n");
const start="<!-- SYSTEM-WORKFLOW-QUEUE:BEGIN -->",end="<!-- SYSTEM-WORKFLOW-QUEUE:END -->";
if(active.includes(start)){
 const first=active.indexOf(start),last=active.indexOf(end);
 if(last<first||active.indexOf(start,first+start.length)!==-1)throw Error("Invalid workflow queue marker layout");
 active=active.slice(0,first)+section+active.slice(last+end.length);
}else{
 const title="# Active execution queue\n";
 if(!active.startsWith(title))throw Error("Unexpected active queue title");
 active=title+"\n"+section+"\n"+active.slice(title.length);
}
if(process.argv.includes("--check")){
 if(readFileSync(jsonPath,"utf8")!==output||readFileSync(path,"utf8").replaceAll("\r\n","\n")!==active)throw Error("Workflow queue outputs are stale; regenerate and review");
 console.log(`Queue verified: ${chains.length} chains, ${legacy.length} linked legacy issues, no missing links or dependency cycles.`);
}else{
 writeFileSync(jsonPath,output);writeFileSync(path,active);
 console.log(`Updated current queue: ${chains.length} chains, ${legacy.length} linked legacy issues, no missing links or dependency cycles.`);
}
