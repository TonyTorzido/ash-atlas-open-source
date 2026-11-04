import type { PlayerAnnouncement } from "@ash-atlas/shared";

import { GameActionPrompt } from "./GameActionPrompt.js";

export function LoginAnnouncementPrompt({
  announcement,
  onClose
}: Readonly<{
  announcement: PlayerAnnouncement | null;
  onClose(): void;
}>): React.JSX.Element | null {
  if (!announcement) return null;
  return (
    <GameActionPrompt
      forced
      title={announcement.title}
      category="ANNOUNCEMENT"
      ariaLabel={`Announcement: ${announcement.title}`}
      content={<p className="announcement-message">{announcement.message}</p>}
      actions={[{
        key: "close",
        label: "Close",
        onSelect: onClose
      }]}
      onCancel={() => {}}
    />
  );
}
