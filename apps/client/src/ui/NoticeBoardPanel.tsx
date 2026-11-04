import type { PlayerAnnouncement } from "@ash-atlas/shared";

import type { PatchNoteRelease } from "../clientRelease.js";
import { AnnouncementsContent } from "./AnnouncementsPanel.js";
import { GameAppShell, GameAppTabs } from "./GameAppShell.js";
import { PatchNotesContent } from "./PatchNotesPanel.js";

export type NoticeBoardTab = "announcements" | "patch-notes";

export function NoticeBoardPanel(props: Readonly<{
  open: boolean;
  activeTab: NoticeBoardTab;
  announcements: readonly PlayerAnnouncement[];
  announcementsLoading?: boolean;
  announcementsError?: string | null;
  patchNoteReleases: readonly PatchNoteRelease[];
  onRetryAnnouncements?(): void;
  onChangeTab(tab: NoticeBoardTab): void;
  onClose(): void;
}>): React.JSX.Element | null {
  return <GameAppShell
    open={props.open}
    title="Notice Board"
    closeLabel="Close Notice Board"
    className="notice-board-app"
    layout="phone"
    phoneBackLabel="Back to Game Menu"
    onClose={props.onClose}
  >
    <GameAppTabs
      variant="housed"
      ariaLabel="Notice Board sections"
      activeTab={props.activeTab}
      onChange={(tab) => props.onChangeTab(tab as NoticeBoardTab)}
      tabs={[
        { id: "announcements", label: "Announcements" },
        { id: "patch-notes", label: "Patch Notes" }
      ]}
    />
    {props.activeTab === "announcements" ? <AnnouncementsContent
      announcements={props.announcements}
      loading={props.announcementsLoading ?? false}
      error={props.announcementsError ?? null}
      {...(props.onRetryAnnouncements ? { onRetry: props.onRetryAnnouncements } : {})}
    /> : <PatchNotesContent releases={props.patchNoteReleases} />}
  </GameAppShell>;
}
