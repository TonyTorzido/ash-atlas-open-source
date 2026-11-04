import { useEffect, useState, useSyncExternalStore } from "react";
import { GameAppActionBar, GameAppButton, GameAppCard } from "./GameAppShell.js";
import { DEFAULT_NATIVE_PUSH_PREFERENCES, disableNativePush, enableNativePush, nativePushSnapshot, openNativeNotificationSettings, refreshNativePush, saveNativePushPreferences, subscribeNativePush } from "../native/nativePush.js";

export function NativeNotificationSettings(): React.JSX.Element {
  const state=useSyncExternalStore(subscribeNativePush,nativePushSnapshot);
  const [draft,setDraft]=useState(state.status?.preferences ?? DEFAULT_NATIVE_PUSH_PREFERENCES);
  useEffect(() => { if(state.status) setDraft(state.status.preferences); },[state.status]);
  useEffect(() => { void refreshNativePush(); },[]);
  return <GameAppCard title="Notifications" className="phone-map-settings phone-account-settings" description="Optional alerts for Messages. Lock-screen previews never include names or message content.">
    <p role="status">{state.busy ? "Updating notifications…" : !state.status ? "Checking availability…" : !state.status.available ? "Notifications are not available in this release yet." : state.permission === "denied" ? "Notifications are blocked in device Settings." : state.status.binding?.enabled && draft.enabled && state.permission === "granted" ? "Notifications are enabled on this device." : "Notifications are off on this device."}</p>
    {state.error ? <p role="alert">{state.error}</p> : null}
    {state.permission === "denied" ? <p>Open your device’s Settings, choose Ash Atlas, and allow Notifications. Then return here and select Refresh.</p> : null}
    <GameAppActionBar>
      {state.permission === "denied" ? <GameAppButton onClick={() => void openNativeNotificationSettings()}>Open notification settings</GameAppButton> : null}
      <GameAppButton disabled={state.busy || !state.status?.available} onClick={() => void enableNativePush()}>Enable on this device</GameAppButton>
      <GameAppButton disabled={state.busy || !state.status} onClick={() => void disableNativePush()}>Turn off notifications</GameAppButton>
      <GameAppButton disabled={state.busy} onClick={() => void refreshNativePush(true)}>Refresh</GameAppButton>
    </GameAppActionBar>
    {state.status?.available ? <>
      <p>These categories and quiet hours apply to your account on every enabled device.</p>
      {([ ["directMessages","Direct messages"], ["invitations","Party and Kingdom invitations"], ["packages","Packages ready"] ] as const).map(([key,label]) =>
        <label className="developer-tool-toggle" key={key}><span>{label}</span><input type="checkbox" checked={draft[key]} disabled={state.busy} onChange={(event) => setDraft({ ...draft,[key]:event.target.checked })}/></label>)}
      <label className="developer-tool-toggle"><span>Quiet hours</span><input type="checkbox" disabled={state.busy} checked={draft.quietStart !== null} onChange={(event) => setDraft({ ...draft,quietStart:event.target.checked ? 22*60 : null,quietEnd:event.target.checked ? 8*60 : null })}/></label>
      {draft.quietStart !== null && draft.quietEnd !== null ? <>
        <label>From <input type="time" value={formatTime(draft.quietStart)} disabled={state.busy} onChange={(event) => { const minutes=parseTime(event.target.value); if(minutes !== null) setDraft({ ...draft,quietStart:minutes }); }}/></label>
        <label>Until <input type="time" value={formatTime(draft.quietEnd)} disabled={state.busy} onChange={(event) => { const minutes=parseTime(event.target.value); if(minutes !== null) setDraft({ ...draft,quietEnd:minutes }); }}/></label>
        <p>{draft.timeZone}. Alerts during quiet hours are skipped, not delayed.</p>
      </> : null}
      <GameAppActionBar><GameAppButton disabled={state.busy} onClick={() => void saveNativePushPreferences(draft)}>Save preferences</GameAppButton></GameAppActionBar>
    </> : null}
    <p>A generic alert already accepted by your device’s notification service may still arrive after sign-out. Opening it always requires the current account.</p>
  </GameAppCard>;
}
function formatTime(minutes: number): string { return `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`; }
function parseTime(value: string): number | null { const match=/^(\d{2}):(\d{2})$/.exec(value); return match ? Number(match[1])*60+Number(match[2]) : null; }
