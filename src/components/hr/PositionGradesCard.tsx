import { useState } from "react";
import { Layers, Plus } from "lucide-react";
import { toast } from "sonner";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useHrWrite } from "@/lib/hr-data";
import { usePositionGrades } from "@/lib/hr-terms";
import { HR_MODULES, type Row } from "@/lib/hr";

/**
 * The company's own position grades.
 *
 * Employment terms and promotions pick from this list, so a promotion is a
 * move between two real grades that can be compared across the workforce
 * instead of free text typed twice.
 */
export function PositionGradesCard() {
  const { can } = useAuth();
  const mayEdit = can(HR_MODULES.employees, "edit");
  const grades = usePositionGrades(true);
  const save = useHrWrite("position_grades", {
    module: "human-resources",
    action: "position-grade.manage",
  });

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [order, setOrder] = useState("");

  const rows = (grades.data ?? []) as Row[];

  function add() {
    const c = code.trim();
    const n = name.trim();
    if (!c || !n) return;
    if (rows.some((g) => String(g["code"]).toLowerCase() === c.toLowerCase())) {
      toast.error("That grade code already exists");
      return;
    }
    save.mutate(
      {
        values: {
          code: c,
          name: n,
          sort_order: Number(order) || rows.length + 1,
          active: true,
        },
        reason: "Position grade created",
      },
      {
        onSuccess: () => {
          setCode("");
          setName("");
          setOrder("");
          toast.success("Grade added");
        },
        onError: (error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Could not add the grade"),
      },
    );
  }

  function toggle(grade: Row) {
    save.mutate(
      {
        id: String(grade["id"]),
        values: { active: grade["active"] === false },
        reason: grade["active"] === false ? "Position grade reinstated" : "Position grade retired",
      },
      {
        onSuccess: () => toast.success("Grade updated"),
        onError: (error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Could not update the grade"),
      },
    );
  }

  return (
    <SectionCard
      title="Position grades"
      description="The company's grade scale. Employment terms and promotions choose from this list; retiring a grade keeps it on existing records but hides it from new ones."
    >
      {mayEdit ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-[8rem_1fr_7rem_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="grade-code">Code</Label>
            <Input
              id="grade-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="G5"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="grade-name">Grade name</Label>
            <Input
              id="grade-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Department Manager"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="grade-order">Order</Label>
            <Input
              id="grade-order"
              inputMode="numeric"
              value={order}
              onChange={(e) => setOrder(e.target.value)}
              placeholder="5"
            />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!code.trim() || !name.trim() || save.isPending}
              onClick={add}
            >
              <Plus className="mr-2 size-4" aria-hidden />
              Add grade
            </Button>
          </div>
        </div>
      ) : null}

      <QueryState
        isLoading={grades.isLoading}
        error={grades.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No grades configured"
            description="Add the grade scale your hotel actually uses. Nothing is created for you."
            icon={Layers}
          />
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>State</TableHead>
                {mayEdit ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
                <TableRow key={String(g["id"])}>
                  <TableCell className="font-medium">{String(g["code"])}</TableCell>
                  <TableCell>{String(g["name"])}</TableCell>
                  <TableCell>{String(g["sort_order"] ?? 0)}</TableCell>
                  <TableCell>
                    <StatusPill tone={g["active"] === false ? "default" : "success"}>
                      {g["active"] === false ? "Retired" : "In use"}
                    </StatusPill>
                  </TableCell>
                  {mayEdit ? (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={save.isPending}
                        onClick={() => toggle(g)}
                      >
                        {g["active"] === false ? "Reinstate" : "Retire"}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>
    </SectionCard>
  );
}
