import { useCallback, useEffect, useState } from "react";

type RpcResponse = {
  data: unknown;
  error: { message: string } | null;
};

type RpcCaller = (
  name: string,
  args: Record<string, unknown>
) => Promise<RpcResponse>;

interface Props {
  callRpc: RpcCaller;
  branchId?: string | null;
}

interface RecoveryRecord {
  failure_id: string;
  order_id: string;
  order_status: string;
  recovery_status: string;
  failure_reason: string | null;
  attempts: number;
  first_failed_at: string;
  order_item_count: number;
  routed_item_count: number;
  ticket_count: number;
}

interface ItemCoverage {
  order_item_id: string;
  item_name: string;
  item_status: string;
  quantity: number;
  coverage_status: string;
  snapshot_count: number;
  successful_postings: number;
  failed_postings: number;
}

interface SupervisorReview {
  id: string;
  review_note: string;
  created_at: string;
  reviewed_by: string;
}

/* neo_multi_station_ui_v1 */

interface SecondaryStationRequirement {
  order_item_id: string;
  item_name: string;
  routing_rule_id: string;
  primary_station_id: string | null;
  primary_station_name: string | null;
  secondary_station_id: string;
  secondary_station_name: string | null;
  active_secondary_ticket_links: number;
  coverage_status: string;
}

interface SecondaryStationCoverage {
  status: string;
  missing_secondary_links: number;
  conflicting_secondary_links: number;
  secondary_station_requirements?: SecondaryStationRequirement[];
}

/* neo_routing_decisions_ui_v1 */

interface ProductionRoutingDecision {
  order_item_id: string;
  routing_status: string;
  configuration_status: string;
  engine_station_id: string | null;
  configured_primary_station_id: string | null;
  configured_secondary_station_id: string | null;
  primary_ticket_links: number;
  secondary_ticket_links: number;
  unexpected_station_links: number;
  engine_rule_agreement: boolean;
  matching_rule_count: number;
  configured_rules?: {
    matching_rules?: Array<{
      rule_id: string;
      primary_station_name: string | null;
      secondary_station_name: string | null;
      priority: number;
    }>;
  };
}

interface ProductionRoutingPlan {
  total_items: number;
  items_with_current_links: number;
  items_requiring_review: number;
  missing_primary_items: number;
  missing_secondary_items: number;
  items?: ProductionRoutingDecision[];
}

interface Investigation {
  ok: boolean;
  order_id: string;
  recovery_status: string;
  coverage_status: string;
  total_items: number;
  verified_items: number;
  items_without_tickets: number;
  items_requiring_review: number;
  station_coverage?: {
    items?: ItemCoverage[];
  };

  secondary_station_coverage?: SecondaryStationCoverage;

  primary_coverage_status?: string;

  secondary_coverage_status?: string;

  missing_secondary_links?: number;

  conflicting_secondary_links?: number;

  routing_verified?: boolean;

  requires_operational_confirmation?: boolean;
  production_routing_plan?: ProductionRoutingPlan;
  routing_decision_review_count?: number;
  routing_primary_missing_count?: number;
  routing_secondary_missing_count?: number;
  supervisor_reviews?: SupervisorReview[];
}

function readable(value?: string | null): string {
  return (value ?? "Unknown")
    .replace(/_/g, " ")
    .replace(/-/g, " ");
}

function formatDate(value?: string | null): string {
  if (!value) return "â€”";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "â€”"
    : date.toLocaleString();
}

export function PosHandoffRecoveryCard({
  callRpc,
  branchId = null,
}: Props) {
  const [records, setRecords] = useState<RecoveryRecord[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(
    null
  );

  const [investigation, setInvestigation] =
    useState<Investigation | null>(null);

  const [note, setNote] = useState("");

  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await callRpc(
        "neo_pos_handoff_recovery_queue",
        {
          _branch: branchId,
          _limit: 100,
        }
      );

      if (result.error) {
        throw new Error(result.error.message);
      }

      setRecords(
        Array.isArray(result.data)
          ? (result.data as RecoveryRecord[])
          : []
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to load recovery queue."
      );
    } finally {
      setLoading(false);
    }
  }, [callRpc, branchId]);

  const loadInvestigation = useCallback(
    async (failureId: string) => {
      setDetailsLoading(true);
      setDetailsError(null);

      try {
        const result = await callRpc(
          "neo_pos_handoff_full_investigation",
          {
            _failure_id: failureId,
          }
        );

        if (result.error) {
          throw new Error(result.error.message);
        }

        setInvestigation(result.data as Investigation);
      } catch (cause) {
        setInvestigation(null);

        setDetailsError(
          cause instanceof Error
            ? cause.message
            : "Unable to load investigation."
        );
      } finally {
        setDetailsLoading(false);
      }
    },
    [callRpc]
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) {
      setInvestigation(null);
      return;
    }

    void loadInvestigation(selectedId);
  }, [selectedId, loadInvestigation]);

  async function saveReview() {
    if (!selectedId || note.trim().length < 10) {
      setDetailsError(
        "A review note must contain at least 10 characters."
      );
      return;
    }

    setSaving(true);
    setDetailsError(null);

    try {
      const result = await callRpc(
        "neo_pos_review_failed_handoff",
        {
          _failure_id: selectedId,
          _review_note: note.trim(),
        }
      );

      if (result.error) {
        throw new Error(result.error.message);
      }

      setNote("");

      await Promise.all([
        loadQueue(),
        loadInvestigation(selectedId),
      ]);
    } catch (cause) {
      setDetailsError(
        cause instanceof Error
          ? cause.message
          : "Unable to save review."
      );
    } finally {
      setSaving(false);
    }
  }

  const items = investigation?.station_coverage?.items ?? [];

  const routingPlan =
    investigation?.production_routing_plan;

  const routingDecisions =
    routingPlan?.items ?? [];

  const itemNames = new Map(
    items.map((item) => [
      item.order_item_id,
      item.item_name,
    ])
  );

  const routingReviewCount =
    investigation?.routing_decision_review_count ?? 0;

  const secondaryRequirements =
    investigation?.secondary_station_coverage
      ?.secondary_station_requirements ?? [];

  const missingSecondary =
    investigation?.missing_secondary_links ?? 0;

  const conflictingSecondary =
    investigation?.conflicting_secondary_links ?? 0;

  const requiresReview =
    investigation !== null &&
    (
      investigation.routing_verified !== true ||
      investigation.requires_operational_confirmation === true ||
      missingSecondary > 0 ||
      conflictingSecondary > 0
    );

  return (
    <section
      style={{
        padding: 20,
        border: "1px solid #d4d4d8",
        borderRadius: 12,
        background: "#fff",
        color: "#18181b",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>
            Production Handoff Recovery
          </h2>

          <p style={{ color: "#71717a", marginBottom: 0 }}>
            Investigate unresolved Kitchen, Bar and Coffee
            Station handoffs after payment confirmation.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadQueue()}
          disabled={loading}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </header>

      {error && (
        <div role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {records.length === 0 && !loading && !error && (
          <p>No unresolved production handoffs found.</p>
        )}

        {records.map((record) => (
          <article
            key={record.failure_id}
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 10,
              padding: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <strong>
                  Order {record.order_id.slice(0, 8)}
                </strong>

                <div
                  style={{
                    fontSize: 13,
                    color: "#71717a",
                  }}
                >
                  {readable(record.recovery_status)}
                  {" Â· "}
                  {formatDate(record.first_failed_at)}
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setSelectedId(record.failure_id);
                  setNote("");
                }}
              >
                Investigate
              </button>
            </div>

            <p>
              {record.failure_reason ||
                "Production handoff requires review."}
            </p>

            <div style={{ fontSize: 13 }}>
              Items: {record.order_item_count}
              {" Â· "}
              Routed: {record.routed_item_count}
              {" Â· "}
              Tickets: {record.ticket_count}
              {" Â· "}
              Attempts: {record.attempts}
            </div>
          </article>
        ))}
      </div>

      {selectedId && (
        <div
          style={{
            marginTop: 24,
            paddingTop: 20,
            borderTop: "2px solid #e4e4e7",
          }}
        >
          <h3>Order Investigation</h3>

          {detailsLoading && <p>Loading investigation...</p>}

          {detailsError && (
            <p role="alert" style={{ color: "#b91c1c" }}>
              {detailsError}
            </p>
          )}

          {investigation && (
            <>
              <p>
                <strong>Routing:</strong>{" "}
                {readable(investigation.coverage_status)}
              </p>

              {requiresReview && (
                <div
                  role="alert"
                  style={{
                    padding: 14,
                    borderRadius: 8,
                    marginBottom: 16,
                    background: "#fff7ed",
                    border: "1px solid #fdba74",
                    color: "#9a3412",
                  }}
                >
                  <strong>
                    Production handoff requires verification
                  </strong>

                  <p style={{ marginBottom: 0 }}>
                    Some production-station requirements
                    are missing, conflicting or not yet
                    fully verified. Existing tickets and
                    payment records must be preserved.
                  </p>
                </div>
              )}

              <p>
                <strong>Primary station:</strong>{" "}
                {readable(
                  investigation.primary_coverage_status
                )}
              </p>

              <p>
                <strong>Secondary stations:</strong>{" "}
                {readable(
                  investigation.secondary_coverage_status
                )}
              </p>

              <p>
                Total items: {investigation.total_items}
                {" Â· "}
                Verified: {investigation.verified_items}
                {" Â· "}
                Missing tickets: {
                  investigation.items_without_tickets
                }
                {" Â· "}
                Review required: {
                  investigation.items_requiring_review
                }
              </p>

              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr>
                      <th align="left">Item</th>
                      <th align="left">Status</th>
                      <th align="left">Station coverage</th>
                      <th align="right">Snapshots</th>
                      <th align="right">Posted</th>
                      <th align="right">Failed</th>
                    </tr>
                  </thead>

                  <tbody>
                    {items.map((item) => (
                      <tr key={item.order_item_id}>
                        <td>{item.item_name}</td>

                        <td>
                          {readable(item.item_status)}
                        </td>

                        <td>
                          {readable(item.coverage_status)}
                        </td>

                        <td align="right">
                          {item.snapshot_count}
                        </td>

                        <td align="right">
                          {item.successful_postings}
                        </td>

                        <td align="right">
                          {item.failed_postings}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                style={{
                  marginTop: 24,
                  borderTop: "1px solid #e4e4e7",
                  paddingTop: 16,
                }}
              >
                <h4>Secondary Production Stations</h4>

                <p>
                  Missing secondary tickets:{" "}
                  <strong>{missingSecondary}</strong>
                  {" · "}
                  Conflicting secondary tickets:{" "}
                  <strong>{conflictingSecondary}</strong>
                </p>

                <p
                  style={{
                    fontSize: 12,
                    color: "#71717a",
                  }}
                >
                  Includes configured stations such as
                  Pastry, Bar, Coffee Station and any other
                  station referenced by applicable rules.
                  Current evidence covers active
                  menu-item secondary routing rules;
                  other rule types are not yet verified.
                </p>

                {secondaryRequirements.length === 0 ? (
                  <p>
                    No active menu-item secondary-station
                    requirements were identified.
                    This does not establish that all
                    possible routing rules are satisfied.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                      }}
                    >
                      <thead>
                        <tr>
                          <th align="left">Item</th>
                          <th align="left">Primary station</th>
                          <th align="left">Secondary station</th>
                          <th align="left">Routing status</th>
                          <th align="right">Active links</th>
                        </tr>
                      </thead>

                      <tbody>
                        {secondaryRequirements.map(
                          (requirement) => (
                            <tr
                              key={
                                requirement.order_item_id +
                                ":" +
                                requirement.routing_rule_id
                              }
                            >
                              <td>
                                {requirement.item_name}
                              </td>

                              <td>
                                {requirement.primary_station_name ??
                                  "Unknown"}
                              </td>

                              <td>
                                <strong>
                                  {requirement.secondary_station_name ??
                                    "Unknown"}
                                </strong>
                              </td>

                              <td>
                                {readable(
                                  requirement.coverage_status
                                )}
                              </td>

                              <td align="right">
                                {
                                  requirement.active_secondary_ticket_links
                                }
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div
                style={{
                  marginTop: 24,
                  paddingTop: 18,
                  borderTop: "1px solid #e4e4e7",
                }}
              >
                <h4>Production Routing Decisions</h4>

                <p>
                  Items requiring routing review:{" "}
                  <strong>{routingReviewCount}</strong>
                  {" · "}
                  Missing primary tickets:{" "}
                  <strong>
                    {investigation.routing_primary_missing_count ?? 0}
                  </strong>
                  {" · "}
                  Missing secondary tickets:{" "}
                  <strong>
                    {investigation.routing_secondary_missing_count ?? 0}
                  </strong>
                </p>

                <p
                  style={{
                    fontSize: 12,
                    color: "#71717a",
                  }}
                >
                  Routing decisions are based on the existing
                  production engine, configured rules and
                  production-ticket links. Conflicts must be
                  investigated before any recovery action.
                </p>

                {routingDecisions.length === 0 ? (
                  <p>
                    No production routing decisions are
                    available for this investigation.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                      }}
                    >
                      <thead>
                        <tr>
                          <th align="left">Order item</th>
                          <th align="left">Routing decision</th>
                          <th align="left">Configured primary</th>
                          <th align="left">Configured secondary</th>
                          <th align="right">Primary tickets</th>
                          <th align="right">Secondary tickets</th>
                          <th align="right">Unexpected links</th>
                        </tr>
                      </thead>

                      <tbody>
                        {routingDecisions.map((decision) => {
                          const rules =
                            decision.configured_rules
                              ?.matching_rules ?? [];

                          const primaryNames = Array.from(
                            new Set(
                              rules
                                .map(
                                  (rule) =>
                                    rule.primary_station_name
                                )
                                .filter(
                                  (name): name is string =>
                                    Boolean(name)
                                )
                            )
                          );

                          const secondaryNames = Array.from(
                            new Set(
                              rules
                                .map(
                                  (rule) =>
                                    rule.secondary_station_name
                                )
                                .filter(
                                  (name): name is string =>
                                    Boolean(name)
                                )
                            )
                          );

                          const requiresAttention =
                            decision.routing_status !==
                            "CURRENT_TICKET_LINKS_PRESENT";

                          return (
                            <tr
                              key={decision.order_item_id}
                              style={{
                                background: requiresAttention
                                  ? "#fff7ed"
                                  : "transparent",
                              }}
                            >
                              <td>
                                <strong>
                                  {itemNames.get(
                                    decision.order_item_id
                                  ) ??
                                    decision.order_item_id.slice(
                                      0,
                                      8
                                    )}
                                </strong>
                              </td>

                              <td>
                                <strong
                                  style={{
                                    color: requiresAttention
                                      ? "#9a3412"
                                      : "#166534",
                                  }}
                                >
                                  {readable(
                                    decision.routing_status
                                  )}
                                </strong>

                                {!decision.engine_rule_agreement &&
                                  decision.matching_rule_count > 0 && (
                                    <div
                                      style={{
                                        fontSize: 12,
                                        color: "#b45309",
                                      }}
                                    >
                                      Engine/rule agreement
                                      not established
                                    </div>
                                  )}
                              </td>

                              <td>
                                {primaryNames.join(", ") ||
                                  decision.configured_primary_station_id ||
                                  "Unconfigured"}
                              </td>

                              <td>
                                {secondaryNames.join(", ") ||
                                  decision.configured_secondary_station_id ||
                                  "None identified"}
                              </td>

                              <td align="right">
                                {decision.primary_ticket_links}
                              </td>

                              <td align="right">
                                {decision.secondary_ticket_links}
                              </td>

                              <td align="right">
                                {decision.unexpected_station_links}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <p
                  style={{
                    fontSize: 12,
                    color: "#71717a",
                    marginTop: 12,
                  }}
                >
                  Production-ticket evidence does not
                  confirm preparation, serving or stock
                  consumption. Automatic ticket recovery
                  remains disabled.
                </p>
              </div>

              <h4>Supervisor Review History</h4>

              {(investigation.supervisor_reviews ?? [])
                .length === 0 ? (
                <p>No supervisor reviews recorded.</p>
              ) : (
                investigation.supervisor_reviews?.map(
                  (review) => (
                    <div
                      key={review.id}
                      style={{
                        padding: 10,
                        borderBottom:
                          "1px solid #e4e4e7",
                      }}
                    >
                      <strong>
                        {formatDate(review.created_at)}
                      </strong>

                      <p>{review.review_note}</p>
                    </div>
                  )
                )
              )}

              <h4>Record Supervisor Review</h4>

              <textarea
                value={note}
                onChange={(event) =>
                  setNote(event.target.value)
                }
                rows={4}
                maxLength={2000}
                placeholder="Describe the missing station handoff and required corrective action..."
                style={{
                  display: "block",
                  width: "100%",
                  marginBottom: 12,
                }}
              />

              <button
                type="button"
                onClick={() => void saveReview()}
                disabled={
                  saving ||
                  note.trim().length < 10
                }
              >
                {saving
                  ? "Saving..."
                  : "Save Review"}
              </button>

              <p
                style={{
                  fontSize: 12,
                  color: "#71717a",
                }}
              >
                Reviews do not recreate tickets,
                repost stock or mark handoffs resolved.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}