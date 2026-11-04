import type { TravelInboxEntry } from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

const NOTICE_DURATION_MS = 7_000;

export function TravelInviteHudNotice({
  entries,
  connected,
  onAccept
}: Readonly<{
  entries: readonly TravelInboxEntry[];
  connected: boolean;
  onAccept(inviteId: string): Promise<boolean>;
}>): React.JSX.Element | null {
  const shownInviteIds = useRef(new Set<string>());
  const [visibleInviteId, setVisibleInviteId] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const visibleInvite = entries.find((entry) =>
    entry.inviteId === visibleInviteId &&
    entry.perspective === "recipient" &&
    entry.status === "pending"
  ) ?? null;

  useEffect(() => {
    if (visibleInvite) return;
    const next = entries.find((entry) =>
      entry.perspective === "recipient" &&
      entry.status === "pending" &&
      !shownInviteIds.current.has(entry.inviteId)
    );
    if (!next) return;
    shownInviteIds.current.add(next.inviteId);
    setAccepting(false);
    setVisibleInviteId(next.inviteId);
  }, [entries, visibleInvite]);

  useEffect(() => {
    if (!visibleInviteId) return;
    const timer = window.setTimeout(() => setVisibleInviteId(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [visibleInviteId]);

  if (!visibleInvite) return null;
  return <aside className="travel-invite-hud-notice" aria-label="Travel invitation" role="region">
    <p aria-live="polite">{visibleInvite.message}</p>
    <div>
      <button
        type="button"
        disabled={!connected || accepting}
        onClick={() => {
          setAccepting(true);
          void onAccept(visibleInvite.inviteId).then((accepted) => {
            if (accepted) setVisibleInviteId(null);
            else setAccepting(false);
          }).catch(() => setAccepting(false));
        }}
      >{accepting ? "Accepting…" : "Accept"}</button>
      <button
        type="button"
        className="secondary"
        disabled={accepting}
        onClick={() => setVisibleInviteId(null)}
      >Close</button>
    </div>
  </aside>;
}
