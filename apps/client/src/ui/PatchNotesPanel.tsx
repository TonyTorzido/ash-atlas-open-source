import type { PatchNoteRelease } from "../clientRelease.js";
import { GameAppCard, GameAppShell } from "./GameAppShell.js";
import { GameMessageBox } from "./GameMessageBox.js";

type Props = Readonly<{
  open: boolean;
  releases: readonly PatchNoteRelease[];
  layout?: "desktop" | "phone";
  onClose(): void;
}>;

const PATCH_NOTE_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short"
});

function formatPatchNoteTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : PATCH_NOTE_TIMESTAMP_FORMATTER.format(date);
}

export function PatchNotesPanel(props: Props): React.JSX.Element | null {
  return (
    <GameAppShell
      open={props.open}
      title="Patch Notes"
      closeLabel="Close Patch Notes"
      className="patch-notes-app"
      layout={props.layout ?? "phone"}
      phoneBackLabel="Back to Game Menu"
      onClose={props.onClose}
    >
      <PatchNotesContent releases={props.releases} />
    </GameAppShell>
  );
}

export function PatchNotesContent({ releases }: Readonly<{
  releases: readonly PatchNoteRelease[];
}>): React.JSX.Element {
  return <section className="patch-notes-release-list" aria-label="Patch note releases">
        {releases.length === 0 ? (
          <GameAppCard title="Patch Notes Unavailable" badge="Unavailable">
            <p>Recent update notes are not available for this game version.</p>
          </GameAppCard>
        ) : releases.map((release) => {
          const formattedCreatedAt = formatPatchNoteTimestamp(release.createdAt);
          return (
            <GameMessageBox
              key={release.gameSha}
              title={release.publicVersion ? `Version ${release.publicVersion}` : "Update"}
              meta={(
                <>
                  {release.gameGeneration}
                  {formattedCreatedAt ? (
                    <> · <time dateTime={release.createdAt ?? undefined}>Created {formattedCreatedAt}</time></>
                  ) : null}
                </>
              )}
            >
              <ul>
                {release.patchNotes.map((note, index) => (
                  <li key={`${index}:${note}`}>{note}</li>
                ))}
              </ul>
            </GameMessageBox>
          );
        })}
      </section>;
}
