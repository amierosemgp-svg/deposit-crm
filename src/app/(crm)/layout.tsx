import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/topnav";
import { PlayerProfileProvider } from "@/components/player-name-link";
import { ClientOnly } from "@/components/client-only";
import { StoreHydrator } from "@/components/store-hydrator";
import { BotLiveFeed } from "@/components/bot-live-feed";

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
      {/* Docked bottom-left on every page. Client-only: it polls on mount and
          has nothing meaningful to render on the server. */}
      <ClientOnly>
        <BotLiveFeed />
      </ClientOnly>
    </PlayerProfileProvider>
  );
}
