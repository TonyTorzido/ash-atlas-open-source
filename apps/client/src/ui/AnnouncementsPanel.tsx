import type { PlayerAnnouncement } from "@ash-atlas/shared";

import {
  GameAppActionBar,
  GameAppCard,
  GameAppShell
} from "./GameAppShell.js";
import { GameMessageBox } from "./GameMessageBox.js";

type Props = Readonly<{
  open: boolean;
  announcements: readonly PlayerAnnouncement[];
  loading?: boolean;
  error?: string | null;
  layout?: "desktop" | "phone";
  onRetry?(): void;
  onClose(): void;
}>;

export function AnnouncementsPanel(props: Props): React.JSX.Element | null {
  return (
    <GameAppShell
      open={props.open}
      title="Announcements"
      closeLabel="Close Announcements"
      className="announcements-app"
      layout={props.layout ?? "phone"}
      phoneBackLabel="Back to Game Menu"
      onClose={props.onClose}
    >
      <AnnouncementsContent
        announcements={props.announcements}
        loading={props.loading ?? false}
        error={props.error ?? null}
        {...(props.onRetry ? { onRetry: props.onRetry } : {})}
      />
    </GameAppShell>
  );
}

export function AnnouncementsContent(props: Readonly<{
  announcements: readonly PlayerAnnouncement[];
  loading?: boolean;
  error?: string | null;
  onRetry?(): void;
}>): React.JSX.Element {
  return <section className="announcements-list" aria-label="Player announcements" aria-busy={props.loading}>
        {props.loading ? (
          <GameAppCard title="Loading Announcements" badge="Loading">
            <p>Loading recent messages…</p>
          </GameAppCard>
        ) : props.error ? (
          <GameAppCard
            title="Announcements Unavailable"
            badge="Unavailable"
            action={props.onRetry ? (
              <GameAppActionBar>
                <button type="button" onClick={props.onRetry}>Retry</button>
              </GameAppActionBar>
            ) : undefined}
          >
            <p role="alert">{props.error}</p>
          </GameAppCard>
        ) : props.announcements.length === 0 ? (
          <GameAppCard title="No Announcements" badge="Current">
            <p>There are no player announcements yet.</p>
          </GameAppCard>
        ) : props.announcements.map((announcement) => (
          <AnnouncementCard key={announcement.id} announcement={announcement} />
        ))}
      </section>;
}

export function AnnouncementCard({ announcement }: { announcement: PlayerAnnouncement }): React.JSX.Element {
  return (
    <GameMessageBox
      title={announcement.title}
      meta={<time dateTime={announcement.publishedAt}>{formatPublishedAt(announcement.publishedAt)}</time>}
    >
      <p className="announcement-message">{announcement.message}</p>
    </GameMessageBox>
  );
}

function formatPublishedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
