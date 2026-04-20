import { Card, CardContent } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";

export default function ReportsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Revenue, GGR, and operational analytics
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <BarChart3 className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-base font-semibold">Reports — Coming Soon</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            This section will show daily deposit/withdrawal totals, per-company GGR, CS
            agent performance, and player retention charts. Out of scope for this
            prototype demo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
