import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/topnav";
import { PageContainer } from "@/components/layout/page-container";
import { PlayerProfileProvider } from "@/components/player-name-link";
import { ClientOnly } from "@/components/client-only";
import { StoreHydrator } from "@/components/store-hydrator";
import { BotLiveFeed } from "@/components/bot-live-feed";
import { KillSwitchListener } from "@/components/kill-switch";

export default function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PlayerProfileProvider>
      <StoreHydrator />
      {/* The shell is exactly one viewport tall and never scrolls itself — the
          header and sidebar stay put while only <main> scrolls. */}
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopNav />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto bg-muted/30">
            {/* Width/scroll behavior is per-route: normal pages get the
                centered column, the spreadsheet view gets the full area. */}
            <PageContainer>
              <ClientOnly
                fallback={
                  <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
                    Loading…
                  </div>
                }
              >
                {children}
              </ClientOnly>
            </PageContainer>
          </main>
        </div>
      </div>
      {/* Docked bottom-left on every page. Client-only: it polls on mount and
          has nothing meaningful to render on the server. */}
      <ClientOnly>
        <BotLiveFeed />
        {/* Ctrl+Alt+Delete — the admin's emergency kill switch. */}
        <KillSwitchListener />
      </ClientOnly>
    </PlayerProfileProvider>
  );
}
