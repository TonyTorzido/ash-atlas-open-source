import type { PlayerAnnouncement } from "@ash-atlas/shared";

import { GameMessageBox } from "./GameMessageBox.js";
import { GamePromptButton } from "./GameActionPrompt.js";

export function AnnouncementHudNotice({ announcement, error, onClose }: Readonly<{
  announcement: PlayerAnnouncement | null;
  error: string | null;
  onClose(): void;
}>): React.JSX.Element | null {
  if (!announcement) return null;
  return <aside className="announcement-hud-notice" aria-label="Player announcement" role="region" aria-live="polite">
    <GameMessageBox
      compact
      title={announcement.title}
      meta={<time dateTime={announcement.publishedAt}>Announcement</time>}
      footer={<GamePromptButton onClick={onClose}>Close</GamePromptButton>}
    >
      <p>{announcement.message}</p>
      {error ? <p className="announcement-hud-notice__error" role="alert">{error} Close to retry.</p> : null}
    </GameMessageBox>
  </aside>;
}
