/**
 * My work — the departmental face of NEØ.
 *
 * Senior roles open the whole Intelligence surface; everybody else gets the
 * same engine narrowed to what they already hold. The server routine resolves
 * organisation, property and capability before a single figure is read, so a
 * person only ever sees the work their permissions already reach.
 */
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { MyWorkBoard } from "@/components/intelligence/MyWork";
import { DepartmentAsk } from "@/components/intelligence/DepartmentAsk";
import { DepartmentBoard } from "@/components/intelligence/DepartmentBoard";
import { useMyWork } from "@/lib/my-work";
import { useBranchScope } from "@/lib/branches";

export const Route = createFileRoute("/_shell/my-work")({
  head: () => ({
    meta: [
      { title: "My work — NEØ" },
      {
        name: "description",
        content:
          "What needs you now, composed from the modules your permissions already reach in the property you are working in.",
      },
      { property: "og:title", content: "My work — NEØ" },
      {
        property: "og:description",
        content: "Your own work queue, scoped to your permissions and current property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MyWorkPage,
});

function MyWorkPage() {
  const branchScope = useBranchScope();
  const branchId = branchScope.activeBranchId === "all" ? null : branchScope.activeBranchId;
  const propertyLabel =
    branchScope.activeBranch?.name ?? (branchId ? "Selected property" : "All permitted properties");
  const myWork = useMyWork(branchId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My work"
        description="What needs you now, from the modules your permissions already reach. Change the property in the top bar to move NEØ with you."
      />
      {myWork.isLoading ? (
        <LoadingState variant="cards" rows={3} />
      ) : myWork.error ? (
        <ErrorState error={myWork.error} title="My work unavailable" />
      ) : (
        <>
          <MyWorkBoard
            items={myWork.data?.items ?? []}
            propertyLabel={propertyLabel}
            today={myWork.data?.today}
            lensNote="NEØ shows only the areas your permissions already reach."
          />
          <DepartmentAsk
            items={myWork.data?.items ?? []}
            branchId={branchId}
            propertyLabel={propertyLabel}
          />
          <DepartmentBoard items={myWork.data?.items ?? []} />
        </>
      )}
    </div>
  );
}
