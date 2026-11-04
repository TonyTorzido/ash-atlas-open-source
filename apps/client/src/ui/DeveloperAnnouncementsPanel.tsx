import {
  PLAYER_ANNOUNCEMENT_MESSAGE_MAX_LENGTH,
  PLAYER_ANNOUNCEMENT_TITLE_MAX_LENGTH,
  type PlayerAnnouncement
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { AnnouncementClient } from "../announcements/announcementClient.js";

export function DeveloperAnnouncementsPanel({
  serverHttpBase,
  csrfToken
}: Readonly<{ serverHttpBase: string; csrfToken: string }>): React.JSX.Element {
  const api = useMemo(
    () => new AnnouncementClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<PlayerAnnouncement[]>([]);
  const operationKeyRef = useRef<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setRecent((await api.list()).announcements);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load announcements");
    }
  };
  useEffect(() => { void load(); }, [api]);

  const publish = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    operationKeyRef.current ??= crypto.randomUUID();
    try {
      const result = await api.publish({
        operationKey: operationKeyRef.current,
        title: title.trim(),
        message: message.trim()
      });
      setStatus(result.replayed ? "Announcement publication confirmed." : "Announcement published.");
      operationKeyRef.current = null;
      setTitle("");
      setMessage("");
      setReviewing(false);
      await load();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish announcement");
    } finally {
      setBusy(false);
    }
  };

  const valid = title.trim().length > 0 && message.trim().length > 0;
  return (
    <section className="developer-announcements" aria-label="Player announcements administration">
      <h3>Player Announcements</h3>
      <p className="muted">Publish a durable message shown to players at login and in Support.</p>
      <div className="dev-form">
        <label>
          Title
          <input
            value={title}
            maxLength={PLAYER_ANNOUNCEMENT_TITLE_MAX_LENGTH}
            disabled={busy || reviewing}
            onChange={(event) => { setTitle(event.currentTarget.value); operationKeyRef.current = null; }}
          />
        </label>
        <label>
          Message
          <textarea
            value={message}
            maxLength={PLAYER_ANNOUNCEMENT_MESSAGE_MAX_LENGTH}
            rows={6}
            disabled={busy || reviewing}
            onChange={(event) => { setMessage(event.currentTarget.value); operationKeyRef.current = null; }}
          />
        </label>
        {!reviewing ? (
          <button type="button" disabled={!valid || busy} onClick={() => setReviewing(true)}>
            Review Announcement
          </button>
        ) : (
          <div className="developer-announcement-review">
            <strong>{title.trim()}</strong>
            <p>{message.trim()}</p>
            <div className="dev-quick-actions">
              <button type="button" disabled={busy} onClick={() => void publish()}>
                {busy ? "Publishing…" : "Publish Announcement"}
              </button>
              <button type="button" disabled={busy} onClick={() => setReviewing(false)}>Edit</button>
            </div>
          </div>
        )}
      </div>
      {status ? <p role="status" className="dev-feedback">{status}</p> : null}
      {error ? <p role="alert" className="dev-feedback">{error}</p> : null}
      <div className="developer-announcement-history">
        <h4>Recent History</h4>
        {recent.length === 0 ? <p className="muted">No announcements published.</p> : recent.slice(0, 10).map((announcement) => (
          <article key={announcement.id}>
            <strong>{announcement.title}</strong>
            <time dateTime={announcement.publishedAt}>{new Date(announcement.publishedAt).toLocaleString()}</time>
            <p>{announcement.message}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
