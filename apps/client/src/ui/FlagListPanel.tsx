import { useState } from "react";
import { FlagManagementView, type FlagManagementTab } from "./FlagManagementView.js";
import { HarvestTollsPanel } from "./HarvestTollsPanel.js";
import { GameAppShell, GameAppTabs } from "./GameAppShell.js";
import type { AtlasShrineMutationResult } from "../flags/atlasShrines.js";
import type { FlagSnapshot } from "@ash-atlas/shared";

export type LandManagementSection = "access-travel" | "harvest-tolls";

const ACCESS_TRAVEL_TABS: readonly Readonly<{ id: FlagManagementTab; label: string }>[] = [
  { id: "defaults", label: "Visit Tolls" },
  { id: "atlas_shrines", label: "Atlas Shrines" },
  { id: "normal", label: "Normal Passage" }
];

type FlagListPanelProps = {
  open: boolean;
  serverHttpBase?: string;
  csrfToken?: string;
  accessRevision?: number;
  layout?: "desktop" | "phone";
  onClose(): void;
  onTravelAtlasShrine(flagId: string): void;
  onAtlasShrineMutation?(result: AtlasShrineMutationResult): void;
  onAtlasShrineRenamed?(flag: FlagSnapshot): void;
};

export function FlagListPanel({
  open,
  serverHttpBase = window.location.origin,
  csrfToken = "",
  accessRevision = 0,
  layout = "desktop",
  onClose,
  onTravelAtlasShrine,
  onAtlasShrineMutation,
  onAtlasShrineRenamed
}: FlagListPanelProps): React.JSX.Element | null {
  const [section, setSection] = useState<LandManagementSection>("access-travel");
  const [accessTab, setAccessTab] = useState<FlagManagementTab>("defaults");

  if (!open) {
    return null;
  }

  const sectionTabs = <GameAppTabs
    variant="housed"
    ariaLabel="Land management sections"
    activeTab={section}
    onChange={(entry) => setSection(entry as LandManagementSection)}
    tabs={[
      { id: "access-travel", label: "Access & Travel" },
      { id: "harvest-tolls", label: "Harvest Tolls" }
    ]}
  />;
  const accessTabs = <GameAppTabs
    variant="subtabs"
    ariaLabel="Access and travel sections"
    activeTab={accessTab}
    onChange={(entry) => setAccessTab(entry as FlagManagementTab)}
    tabs={ACCESS_TRAVEL_TABS}
  />;
  const managementProps = {
    serverHttpBase,
    csrfToken,
    revision: accessRevision,
    onTravelAtlasShrine,
    ...(onAtlasShrineMutation ? { onAtlasShrineMutation } : {}),
    ...(onAtlasShrineRenamed ? { onAtlasShrineRenamed } : {})
  };
  const content = <>
    {sectionTabs}
    {section === "access-travel" ? <div className="land-management-access-body">
      {accessTabs}
      <FlagManagementView tab={accessTab} {...managementProps} />
    </div> : null}
    {section === "harvest-tolls" ? <HarvestTollsPanel
      open
      embedded
      layout={layout}
      serverHttpBase={serverHttpBase}
      csrfToken={csrfToken}
      onClose={onClose}
    /> : null}
  </>;

  return <GameAppShell
    open
    menuId="flags"
    title="Land Management"
    closeLabel="Close Land Management"
    className="flag-list-panel"
    layout={layout}
    phoneBackLabel="Back to Game Menu"
    onClose={onClose}
  ><div className="phone-flags-body">{content}</div></GameAppShell>;
}

