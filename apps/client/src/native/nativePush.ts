import { PushNotifications } from "@capacitor/push-notifications";
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { DEFAULT_NATIVE_PUSH_PREFERENCES, type NativePushDestination, type NativePushPreferences, type NativePushStatus } from "@ash-atlas/shared";
import { clientConfig } from "../config.js";
import { nativeAuthRequest } from "./nativeRequest.js";
import { nativeLogoutPending } from "./nativeLogout.js";
import { recordNativeDiagnostic } from "./nativeDiagnostics.js";

type Snapshot = { status: NativePushStatus | null; permission: string; busy: boolean; error: string | null };
let snapshot: Snapshot = { status: null, permission: "prompt", busy: false, error: null };
const listeners = new Set<() => void>();
let initialized: Promise<void> | undefined;
let generation = 0;
let context: { playerId: string; csrfToken: string; generation: number; owner: symbol } | null = null;
let registrationGeneration: number | null = null;
let tokenEventRevision = 0;
let pendingTap: { id: string; at: number } | null = null;
const seenTaps = new Set<string>();
let onTap: (() => void) | null = null;
let onForeground: (() => void) | null = null;
let operation: Promise<unknown> = Promise.resolve();
const nativeRuntime=registerPlugin<{ openNotificationSettings(): Promise<void>; pausePushAutoInit(): Promise<void> }>("NativeRuntime");
async function registerCurrentToken(): Promise<void> {
  try { await PushNotifications.register(); }
  finally { await nativeRuntime.pausePushAutoInit(); }
}
export async function openNativeNotificationSettings(): Promise<void> {
  try { await nativeRuntime.openNotificationSettings(); }
  catch { update({ error:"Open your device’s Settings, choose Ash Atlas, then Notifications." }); }
}
export const nativePushEnabled = (): boolean => Capacitor.isNativePlatform() && import.meta.env.VITE_NATIVE_PUSH_ENABLED === "true";
export const nativePushSnapshot = (): Snapshot => snapshot;
export const subscribeNativePush = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(value: Partial<Snapshot>): void { snapshot = { ...snapshot, ...value }; for (const listener of listeners) listener(); }
async function api<T>(path: string, body?: unknown, expectedGeneration = context?.generation): Promise<T> {
  const current = context;
  if (!current || current.generation !== expectedGeneration || nativeLogoutPending()) throw new Error("Sign in again to manage notifications.");
  const response = await nativeAuthRequest(new URL(`/api/native-push${path}`,clientConfig.serverHttpBase), {
    method: body === undefined ? "GET" : "POST", headers: { "content-type":"application/json", "x-csrf-token":current.csrfToken },
    ...(body === undefined ? {} : { body:JSON.stringify(body) })
  });
  if (context?.generation !== current.generation || nativeLogoutPending()) throw new Error("The account changed.");
  const payload = await response.json() as T & { error?: { message?: string } };
  if (context?.generation !== current.generation || nativeLogoutPending()) throw new Error("The account changed.");
  if (!response.ok) throw new Error(payload.error?.message ?? "Notifications are temporarily unavailable.");
  return payload;
}
function enqueue(work: (expectedGeneration: number) => Promise<void>): Promise<void> {
  const expectedGeneration = context?.generation;
  let cancelled = false;
  if (expectedGeneration !== undefined) update({ busy:true,error:null });
  const task = operation.catch(() => undefined).then(async () => {
    if (cancelled || expectedGeneration === undefined || context?.generation !== expectedGeneration) return;
    update({ busy:true,error:null });
    try { await work(expectedGeneration); }
    catch (error) { if (context?.generation === expectedGeneration) update({ error:error instanceof Error ? error.message : "Notifications are temporarily unavailable." }); }
    finally { if (context?.generation === expectedGeneration) update({ busy:false }); }
  });
  operation = task;
  return new Promise<void>((resolve) => {
    const timeout=setTimeout(() => {
      cancelled=true;
      if (context && context.generation === expectedGeneration) {
        context={ ...context,generation:++generation };
        registrationGeneration=null;
        update({ busy:false,error:"Notifications are still waiting on your device. Fully close and reopen Ash Atlas if this continues." });
      }
      resolve();
    },30_000);
    void task.finally(() => { clearTimeout(timeout); resolve(); });
  });
}
export function initializeNativePush(): Promise<void> {
  if (!nativePushEnabled()) return Promise.resolve();
  initialized ??= (async () => {
    await PushNotifications.addListener("registration",({ value }) => {
      const expected = registrationGeneration;
      const tokenRevision = ++tokenEventRevision;
      if (expected === null || context?.generation !== expected || nativeLogoutPending()) return;
      void enqueue(async (current) => {
        if (current !== expected || tokenRevision !== tokenEventRevision) return;
        const status = await api<NativePushStatus>("",undefined,current);
        if (!status.preferences.enabled || !status.available || tokenRevision !== tokenEventRevision || registrationGeneration !== current) return;
        const registered = await api<NativePushStatus>("/register", { token:value, platform:Capacitor.getPlatform(), expectedEpoch:status.binding?.epoch ?? 0, expectedTokenVersion:status.binding?.tokenVersion ?? 0 },current);
        update({ status:registered });
        recordNativeDiagnostic("push_registered");
      });
    });
    await PushNotifications.addListener("registrationError",() => { if (registrationGeneration !== context?.generation || nativeLogoutPending()) return; registrationGeneration=null;recordNativeDiagnostic("push_failed"); update({ error:"This device could not register for notifications. Try again." }); });
    await App.addListener("appStateChange",({ isActive }) => { if (isActive && context && !nativeLogoutPending()) void refreshNativePush(true); });
    await PushNotifications.addListener("pushNotificationReceived",() => { recordNativeDiagnostic("push_received"); if (context && !nativeLogoutPending()) onForeground?.(); });
    await PushNotifications.addListener("pushNotificationActionPerformed",({ notification }) => {
      const id: unknown = notification.data?.deliveryId;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id) || nativeLogoutPending() || seenTaps.has(id)) return;
      pendingTap={ id,at:Date.now() };recordNativeDiagnostic("push_tapped"); onTap?.();
    });
    if (Capacitor.getPlatform() === "android") await PushNotifications.createChannel({ id:"messages",name:"Messages",description:"Direct messages, invitations, and packages",importance:3,visibility:0 });
  })().catch(() => { initialized=undefined; update({ error:"Notifications could not be initialized. Try again." }); });
  return initialized;
}
export function bindNativePushSession(playerId: string, csrfToken: string): () => void {
  if (!nativePushEnabled()) return () => {};
  const current = { playerId,csrfToken,generation:++generation,owner:Symbol("push-session") };
  context=current;
  registrationGeneration=null;
  update({ status:null,permission:"prompt",busy:false,error:null });
  void refreshNativePush(true);
  return () => { if (context?.owner === current.owner) { context=null; registrationGeneration=null; pendingTap=null; generation++; update({ status:null,busy:false,error:null }); } };
}
export function refreshNativePush(registerIfEnabled = false): Promise<void> {
  return enqueue(async (current) => {
    await initializeNativePush();
    const permission = await PushNotifications.checkPermissions();
    const status = await api<NativePushStatus>("",undefined,current);
    update({ status,permission:permission.receive });
    if (registerIfEnabled && permission.receive === "granted" && status.available && status.preferences.enabled) {
      registrationGeneration=current; await registerCurrentToken();
    }
  });
}
export function saveNativePushPreferences(preferences: NativePushPreferences): Promise<void> {
  return enqueue(async (current) => { update({ status:await api<NativePushStatus>("/preferences",preferences,current) }); });
}
export function enableNativePush(): Promise<void> {
  return enqueue(async (current) => {
    await initializeNativePush();
    const status = await api<NativePushStatus>("",undefined,current);
    if (!status.available) throw new Error("Notifications are not available yet.");
    const permission = await PushNotifications.requestPermissions();
    if (context?.generation !== current) return;
    update({ permission:permission.receive });
    if (permission.receive !== "granted") throw new Error("Allow notifications in your device's Settings, then return here and refresh.");
    const preferences = { ...status.preferences,enabled:true,timeZone:status.preferences.revision === 0 ? Intl.DateTimeFormat().resolvedOptions().timeZone : status.preferences.timeZone };
    update({ status:await api<NativePushStatus>("/preferences",preferences,current) });
    registrationGeneration=current;
    await registerCurrentToken();
  });
}
export function disableNativePush(): Promise<void> {
  registrationGeneration=null;
  return enqueue(async (current) => {
    const status = await api<NativePushStatus>("",undefined,current);
    update({ status:await api<NativePushStatus>("/preferences",{ ...status.preferences,enabled:false },current) });
    if (status.binding?.enabled) update({ status:await api<NativePushStatus>("/reset",{ expectedEpoch:status.binding.epoch },current) });
    await PushNotifications.removeAllDeliveredNotifications();
    await PushNotifications.unregister();
  });
}
export async function clearNativePushForLogout(): Promise<void> {
  if (!nativePushEnabled()) return;
  context=null; generation++; registrationGeneration=null; pendingTap=null; seenTaps.clear();
  update({ status:null,busy:false,error:null });
  // The logout/session-revocation transaction invalidates the server binding even
  // if network access is unavailable here. Already accepted generic pushes may arrive.
  const cleanup=operation.catch(() => undefined).then(() => Promise.allSettled([PushNotifications.removeAllDeliveredNotifications(),PushNotifications.unregister()]));
  operation=cleanup;
  await cleanup;
}
export function subscribeNativePushIntents(tap: () => void, foreground: () => void): () => void {
  onTap=tap; onForeground=foreground; if (pendingTap) tap();
  return () => { if (onTap===tap) onTap=null; if(onForeground===foreground) onForeground=null; };
}
export async function consumeNativePushDestination(): Promise<NativePushDestination | null> {
  const intent=pendingTap;
  if (!intent || !context || nativeLogoutPending()) return null;
  if (Date.now()-intent.at>600_000) { pendingTap=null; return null; }
  pendingTap=null;
  const current=context.generation;
  let result: NativePushDestination;
  try { result=await api<NativePushDestination>("/destination",{ deliveryId:intent.id },current); }
  catch (error) {
    if(context?.generation===current && !pendingTap) pendingTap=intent;
    throw error;
  }
  seenTaps.add(intent.id); if(seenTaps.size>50) seenTaps.delete(seenTaps.values().next().value!);
  return result;
}
export { DEFAULT_NATIVE_PUSH_PREFERENCES };
