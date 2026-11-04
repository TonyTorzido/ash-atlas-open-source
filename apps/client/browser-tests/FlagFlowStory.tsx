import type { FlagSnapshot, PlayerSnapshot } from "@ash-atlas/shared";
import { useCallback, useState } from "react";

import { useFlagAccessMenu } from "../src/flags/useFlagAccessMenu.js";
import { MobileFlagActionSheet } from "../src/ui/MobileFlagActionSheet.js";

export function FlagFlowStory({
  flag,
  player
}: {
  flag: FlagSnapshot;
  player: PlayerSnapshot;
}): React.JSX.Element | null {
  const [view, setView] = useState<"interaction" | "management" | "closed">("interaction");
  const handleFailure = useCallback(() => setView("closed"), []);
  const resolved = useFlagAccessMenu({
    flagId: view === "closed" ? null : flag.id,
    accessRevision: 1,
    serverHttpBase: "https://game.example",
    onFailure: handleFailure
  });
  if (view === "closed" || !resolved.access || !resolved.traceId) return null;
  return <MobileFlagActionSheet
    flag={flag}
    player={player}
    walletGold="20"
    serverHttpBase="https://game.example"
    csrfToken="csrf"
    access={resolved.access}
    aggressiveRemainingMs={0}
    connected
    managementOpen={view === "management"}
    onVisit={() => true}
    onManage={() => setView("management")}
    onReturnToGame={() => setView("closed")}
    onClose={() => setView("closed")}
    onAccessChange={resolved.updateAccess}
  />;
}
