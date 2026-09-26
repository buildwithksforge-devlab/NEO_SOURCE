import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { SelfApprovalExceptions } from "@/components/admin/SelfApprovalExceptions";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/self-approval-exceptions")({
  head: () => ({
    meta: [
      { title: "Self-approval exceptions — NEØ Administration" },
      {
        name: "description",
        content:
          "Record dated, written exceptions to the rule that nobody may approve a record they raised themselves, workflow by workflow.",
      },
      { property: "og:title", content: "Self-approval exceptions — NEØ Administration" },
      {
        property: "og:description",
        content:
          "Per-workflow, date-bound exceptions to maker/checker separation, with every use logged.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SelfApprovalExceptionsPage,
});

function SelfApprovalExceptionsPage() {
  const { can, isAdmin } = useAuth();
  const mayConfigure = isAdmin || can("administration", "approvals", "edit");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Self-approval exceptions"
        description="By default nobody may approve a record they raised themselves, whatever their role. An exception applies to one workflow, runs between the dates you set, and every use of it is logged against both the person who raised the record and the person who approved it."
      />
      <SelfApprovalExceptions mayConfigure={mayConfigure} />
    </div>
  );
}
