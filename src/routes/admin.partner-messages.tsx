/**
 * Partner Messages — the hotel's inbox.
 *
 * Every conversation a partner has started or the hotel has started with them,
 * for one property, with the real messages held in the database. Replying uses
 * the same canonical routine the Partner Billing screen already uses, so a
 * reply here appears in the partner's own portal conversation.
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MessageSquare } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useBranches } from "@/lib/branches";
import { useHotelPartnerSend, useHotelPartnerThreads } from "@/lib/partner-billing";

export const Route = createFileRoute("/admin/partner-messages")({
  head: () => ({
    meta: [
      { title: "Partner Messages — Configuration Centre" },
      {
        name: "description",
        content:
          "Read and reply to the conversations your suppliers and corporate partners have with this property.",
      },
      { property: "og:title", content: "Partner Messages — Configuration Centre" },
      {
        property: "og:description",
        content: "One inbox for every partner conversation on this property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PartnerMessagesPage,
});

type Conversation = {
  thread_id: string;
  subject: string;
  status: string;
  last_message_at: string | null;
  relationship_id: string;
  partner_name: string | null;
  relationship_type: string | null;
  last_body: string | null;
  last_side: string | null;
  message_count: number;
};

function when(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function PartnerMessagesPage() {
  const branches = useBranches();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [newSubject, setNewSubject] = useState("");

  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0]!.id);
  }, [branches.data, branchId]);

  const inbox = useQuery({
    queryKey: ["hotel-partner-inbox", branchId],
    enabled: Boolean(branchId),
    queryFn: async (): Promise<Conversation[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_hotel_partner_inbox", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { allowed?: boolean; conversations?: Conversation[] };
      if (!result.allowed) return [];
      return result.conversations ?? [];
    },
  });

  const selected = useMemo(
    () => inbox.data?.find((c) => c.thread_id === threadId) ?? null,
    [inbox.data, threadId],
  );

  const threads = useHotelPartnerThreads(selected?.relationship_id ?? null);
  const send = useHotelPartnerSend(selected?.relationship_id ?? null);

  const conversation = useMemo(
    () => threads.data?.find((t) => t.id === selected?.thread_id) ?? null,
    [threads.data, selected],
  );

  async function submitReply() {
    if (!selected || !reply.trim()) return;
    await send.mutateAsync({ body: reply, threadId: selected.thread_id });
    setReply("");
    void inbox.refetch();
    void threads.refetch();
  }

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Partners"
        title="Partner Messages"
        description="Conversations between this property and the businesses it works with. A reply here lands in the partner's own portal straight away."
      />

      {branches.data?.length ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {branches.data.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                setBranchId(b.id);
                setThreadId(null);
              }}
              className={`rounded-full border px-4 py-1.5 text-xs font-medium ${
                b.id === branchId
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <SectionCard title="Inbox" description="Most recent conversation first.">
          {inbox.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading conversations…
            </div>
          ) : inbox.data?.length ? (
            <ul className="divide-y divide-border">
              {inbox.data.map((c) => (
                <li key={c.thread_id}>
                  <button
                    type="button"
                    onClick={() => setThreadId(c.thread_id)}
                    className={`w-full px-3 py-3 text-left ${
                      c.thread_id === threadId ? "bg-muted" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {c.partner_name ?? "Partner"}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {when(c.last_message_at)}
                      </span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{c.subject}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.last_side === "hotel" ? "You: " : ""}
                      {c.last_body ?? "No messages yet"}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              No partner conversations on this property yet.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title={selected ? selected.subject : "Conversation"}
          description={
            selected
              ? `${selected.partner_name ?? "Partner"}${
                  selected.relationship_type ? ` · ${selected.relationship_type}` : ""
                }`
              : "Choose a conversation on the left."
          }
        >
          {!selected ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <MessageSquare className="size-4" /> Nothing selected.
            </div>
          ) : threads.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading messages…
            </div>
          ) : (
            <div className="space-y-4 p-3">
              <div className="max-h-[26rem] space-y-3 overflow-y-auto pr-1">
                {conversation?.messages?.length ? (
                  conversation.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                        m.side === "hotel"
                          ? "ml-auto border-primary/40 bg-primary/10"
                          : "border-border bg-muted"
                      }`}
                    >
                      <div className="text-[11px] text-muted-foreground">
                        {m.sender_name || (m.side === "hotel" ? "Hotel" : "Partner")} · {when(m.at)}
                      </div>
                      <div className="whitespace-pre-wrap">{m.body}</div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No messages in this conversation.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="partner-reply">Reply</Label>
                <Textarea
                  id="partner-reply"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Write your reply to this partner…"
                  rows={3}
                />
                <Button
                  onClick={() => void submitReply()}
                  disabled={!reply.trim() || send.isPending}
                >
                  {send.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Send reply
                </Button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {selected ? (
        <SectionCard
          className="mt-4"
          title="Start a new conversation"
          description={`A new subject with ${selected.partner_name ?? "this partner"}.`}
        >
          <div className="space-y-2 p-3">
            <Label htmlFor="partner-subject">Subject</Label>
            <Input
              id="partner-subject"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="What is this about?"
            />
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="First message…"
              rows={3}
            />
            <Button
              variant="outline"
              disabled={!newSubject.trim() || !reply.trim() || send.isPending}
              onClick={async () => {
                await send.mutateAsync({ body: reply, subject: newSubject });
                setReply("");
                setNewSubject("");
                void inbox.refetch();
              }}
            >
              Start conversation
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
