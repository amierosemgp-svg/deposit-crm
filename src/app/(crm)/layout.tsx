import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/topnav";
import { PlayerProfileProvider } from "@/components/player-name-link";
import { ClientOnly } from "@/components/client-only";

export default function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PlayerProfileProvider>
      <div className="flex min-h-screen flex-col">
        <TopNav />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-muted/30">
            <div className="mx-auto max-w-[1400px] px-6 py-6">
              <ClientOnly
                fallback={
                  <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
                    Loading…
                  </div>
                }
              >
                {children}
              </ClientOnly>
            </div>
          </main>
        </div>
      </div>
    </PlayerProfileProvider>
  );
}
