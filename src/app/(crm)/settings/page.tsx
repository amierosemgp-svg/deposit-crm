import { Card, CardContent } from "@/components/ui/card";
import { Settings } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          System configuration, bot credentials, game provider APIs, user management
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Settings className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-base font-semibold">Settings — Admin Only</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            This section will manage bot credentials, game provider API keys, bonus
            presets, user roles, and audit log retention. Out of scope for this
            prototype demo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
