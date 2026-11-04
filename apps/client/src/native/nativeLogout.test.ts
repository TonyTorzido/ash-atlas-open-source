// @vitest-environment jsdom
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const runtime=vi.hoisted(() => ({ pending:false,fail:false,getLogoutPending:vi.fn(),setLogoutPending:vi.fn() }));
vi.mock("@capacitor/core",() => ({Capacitor:{isNativePlatform:() => true},registerPlugin:() => runtime}));
beforeEach(() => { vi.resetModules();localStorage.clear();runtime.pending=false;runtime.fail=false;
  runtime.getLogoutPending.mockImplementation(async () => {if(runtime.fail) throw new Error("private native failure");return {pending:runtime.pending};});
  runtime.setLogoutPending.mockImplementation(async ({pending}:{pending:boolean}) => {if(runtime.fail) throw new Error("private native failure");runtime.pending=pending;});
});
afterEach(() => vi.restoreAllMocks());
describe("durable native logout intent",() => {
  it("does not let an old clear callback undo a newer logout lock",async () => {
    let finishClear!:()=>void;
    runtime.setLogoutPending.mockImplementation(({pending}:{pending:boolean}) => pending ? Promise.resolve() : new Promise<void>((resolve) => {finishClear=resolve;}));
    const module=await import("./nativeLogout.js");
    const clearing=module.setNativeLogoutPending(false);
    await module.setNativeLogoutPending(true);
    finishClear();await clearing;
    expect(module.nativeLogoutPending()).toBe(true);
  });
  it("survives a JavaScript reload even when browser storage cannot write",async () => {
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(() => {throw new Error("quota");});
    const first=await import("./nativeLogout.js");
    await first.setNativeLogoutPending(true);
    expect(runtime.pending).toBe(true);
    vi.resetModules();
    const restarted=await import("./nativeLogout.js");
    await restarted.initializeNativeLogout();
    expect(restarted.nativeLogoutPending()).toBe(true);
    await restarted.setNativeLogoutPending(false);
    expect(runtime.pending).toBe(false);
  });
  it("keeps gameplay locked and reports failure when neither storage can save",async () => {
    runtime.fail=true;
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(() => {throw new Error("quota");});
    const module=await import("./nativeLogout.js");
    await expect(module.setNativeLogoutPending(true)).rejects.toThrow("Sign-out could not be saved");
    expect(module.nativeLogoutPending()).toBe(true);
    await expect(module.initializeNativeLogout()).rejects.toThrow("Sign-out could not be saved");
  });
  it("honors legacy browser-only pending logout while moving to the native boolean",async () => {
    localStorage.setItem("ash-atlas-native-logout-pending-v1","true");
    const module=await import("./nativeLogout.js");
    await module.initializeNativeLogout();
    expect(module.nativeLogoutPending()).toBe(true);
  });
});
