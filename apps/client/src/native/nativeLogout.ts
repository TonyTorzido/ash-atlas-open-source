import { Capacitor,registerPlugin } from "@capacitor/core";

const KEY = "ash-atlas-native-logout-pending-v1";
let pending = false;
let revision = 0;
const runtime=registerPlugin<{getLogoutPending():Promise<{pending:boolean}>;setLogoutPending(input:{pending:boolean}):Promise<void>}>("NativeRuntime");
export class NativeLogoutPersistenceError extends Error {
  constructor() { super("Sign-out could not be saved on this device. Keep Ash Atlas open and reconnect to finish signing out."); }
}
export async function initializeNativeLogout(): Promise<void> {
  if(!Capacitor.isNativePlatform()) return;
  try {
    const state=await nativeDeadline(runtime.getLogoutPending());
    if(typeof state.pending!=="boolean") throw new Error("Invalid native logout state");
    pending=nativeLogoutPending() || state.pending;
  } catch { pending=true;throw new NativeLogoutPersistenceError(); }
}

/** Only a boolean is persisted. No session, CSRF token, or account details are stored here. */
export function nativeLogoutPending(): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  try { return pending || localStorage.getItem(KEY) === "true"; }
  catch { return pending; }
}

export async function setNativeLogoutPending(value: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const attempt=++revision;
  if(value) pending=true;
  let localSaved=false;
  try {
    if (value) localStorage.setItem(KEY, "true");
    else localStorage.removeItem(KEY);
    localSaved=true;
  } catch { /* The native boolean is the durable fallback. */ }
  try { await nativeDeadline(runtime.setLogoutPending({pending:value})); }
  catch { if(!localSaved) {pending=true;throw new NativeLogoutPersistenceError();} }
  if(attempt===revision) pending=value;
}
function nativeDeadline<T>(work:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  return Promise.race([work,new Promise<never>((_,reject) => {timer=setTimeout(() => reject(new NativeLogoutPersistenceError()),5_000);})]).finally(() => clearTimeout(timer));
}
