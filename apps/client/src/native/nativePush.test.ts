// @vitest-environment jsdom
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { DEFAULT_NATIVE_PUSH_PREFERENCES } from "@ash-atlas/shared";
type NativePushEventHandler = (event: unknown) => void;
const mock=vi.hoisted(() => ({handlers:new Map<string,NativePushEventHandler>(),request:vi.fn(),permission:vi.fn(async () => ({receive:"granted"})),register:vi.fn(async () => {}),unregister:vi.fn(async () => {}),clear:vi.fn(async () => {}),pending:false}));
vi.mock("@capacitor/core",() => ({Capacitor:{isNativePlatform:() => true,getPlatform:() => "ios"},registerPlugin:() => ({pausePushAutoInit:async () => {},openNotificationSettings:async () => {}})}));
vi.mock("@capacitor/app",() => ({App:{addListener:async (name:string,handler:NativePushEventHandler) => {mock.handlers.set(name,handler);return {remove:async () => {}};}}}));
vi.mock("@capacitor/push-notifications",() => ({PushNotifications:{addListener:async (name:string,handler:NativePushEventHandler) => {mock.handlers.set(name,handler);return {remove:async () => {}};},checkPermissions:mock.permission,requestPermissions:mock.permission,register:mock.register,unregister:mock.unregister,removeAllDeliveredNotifications:mock.clear,createChannel:async () => {}}}));
vi.mock("./nativeRequest.js",() => ({nativeAuthRequest:mock.request}));
vi.mock("./nativeLogout.js",() => ({nativeLogoutPending:() => mock.pending}));
vi.mock("./nativeDiagnostics.js",() => ({recordNativeDiagnostic:vi.fn()}));
vi.mock("../config.js",() => ({clientConfig:{serverHttpBase:"https://playashatlas.com"}}));
beforeEach(() => {vi.resetModules();vi.clearAllMocks();vi.stubEnv("VITE_NATIVE_PUSH_ENABLED","true");mock.handlers.clear();mock.pending=false;mock.permission.mockResolvedValue({receive:"granted"});});
afterEach(() => {vi.unstubAllEnvs();vi.useRealTimers();});
describe("native push account and intent boundaries",() => {
  it("does not ask permission at startup and ignores registration callbacks after offline logout",async () => {
    let status={available:true,binding:null,preferences:{...DEFAULT_NATIVE_PUSH_PREFERENCES}};
    mock.request.mockImplementation(async (url:URL,init:RequestInit) => {
      if(url.pathname.endsWith("/preferences")) status={...status,preferences:{...JSON.parse(String(init.body)),revision:1}};
      return new Response(JSON.stringify(status));
    });
    const push=await import("./nativePush.js");
    await push.initializeNativePush();
    expect(mock.permission).not.toHaveBeenCalled();
    push.bindNativePushSession("account-a-player","csrf-a");
    await vi.waitFor(() => expect(push.nativePushSnapshot().status).not.toBeNull());
    expect(mock.register).not.toHaveBeenCalled();
    await push.enableNativePush();
    expect(mock.register).toHaveBeenCalledOnce();
    mock.pending=true;
    await push.clearNativePushForLogout();
    mock.handlers.get("registration")!({value:"a".repeat(64)});
    await Promise.resolve();
    expect(mock.request.mock.calls.some(([url]) => String(url).includes("/register"))).toBe(false);
    expect(mock.unregister).toHaveBeenCalledOnce();
  });
  it("holds a cold-start tap until a session is bound and accepts only an authenticated destination",async () => {
    mock.request.mockImplementation(async (url:URL) => new Response(JSON.stringify(url.pathname.endsWith("/destination") ? {tab:"requests"} : {available:true,binding:null,preferences:DEFAULT_NATIVE_PUSH_PREFERENCES})));
    const push=await import("./nativePush.js");
    await push.initializeNativePush();
    const id="00000000-0000-4000-8000-000000000111";
    mock.handlers.get("pushNotificationActionPerformed")!({notification:{data:{deliveryId:id,url:"https://attacker.invalid",action:"accept"}}});
    expect(await push.consumeNativePushDestination()).toBeNull();
    push.bindNativePushSession("player","csrf");
    await expect(push.consumeNativePushDestination()).resolves.toEqual({tab:"requests"});
    expect(await push.consumeNativePushDestination()).toBeNull();
    const request=mock.request.mock.calls.find(([url]) => String(url).includes("/destination"));
    expect(JSON.parse(request![1].body)).toEqual({deliveryId:id});
  });
  it("does not attach listeners or register in a disabled build",async () => {
    vi.stubEnv("VITE_NATIVE_PUSH_ENABLED","false");
    const push=await import("./nativePush.js");
    await push.initializeNativePush();push.bindNativePushSession("player","csrf");
    expect(mock.handlers.size).toBe(0);expect(mock.request).not.toHaveBeenCalled();expect(mock.register).not.toHaveBeenCalled();
  });
  it("registers later token rotations with current revisions and refreshes on resume",async () => {
    let version=1;
    const status=() => ({available:true,binding:{epoch:3,tokenVersion:version,enabled:true},preferences:{...DEFAULT_NATIVE_PUSH_PREFERENCES,enabled:true}});
    mock.request.mockImplementation(async (url:URL) => {if(url.pathname.endsWith("/register")) version++;return new Response(JSON.stringify(status()));});
    const push=await import("./nativePush.js");push.bindNativePushSession("player","csrf");
    await vi.waitFor(() => expect(mock.register).toHaveBeenCalledOnce());
    mock.handlers.get("registration")!({value:"a".repeat(64)});
    await vi.waitFor(() => expect(version).toBe(2));
    mock.handlers.get("registration")!({value:"b".repeat(64)});
    await vi.waitFor(() => expect(version).toBe(3));
    const writes=mock.request.mock.calls.filter(([url]) => String(url).endsWith("/register"));
    expect(writes.map(([,init]) => JSON.parse(init.body).expectedTokenVersion)).toEqual([1,2]);
    mock.handlers.get("appStateChange")!({isActive:true});
    await vi.waitFor(() => expect(mock.register).toHaveBeenCalledTimes(2));
  });
  it("rejects a destination whose JSON finishes after an account switch",async () => {
    let finish!:(value:unknown)=>void;
    mock.request.mockImplementation(async (url:URL) => url.pathname.endsWith("/destination") ? {ok:true,json:() => new Promise((resolve) => {finish=resolve;})} : new Response(JSON.stringify({available:true,binding:null,preferences:DEFAULT_NATIVE_PUSH_PREFERENCES})));
    const push=await import("./nativePush.js");await push.initializeNativePush();push.bindNativePushSession("a","csrf-a");
    await vi.waitFor(() => expect(push.nativePushSnapshot().status).not.toBeNull());
    mock.handlers.get("pushNotificationActionPerformed")!({notification:{data:{deliveryId:"00000000-0000-4000-8000-000000000111"}}});
    const result=push.consumeNativePushDestination();const rejection=expect(result).rejects.toThrow("account changed");
    await vi.waitFor(() => expect(finish).toBeDefined());
    push.bindNativePushSession("b","csrf-b");expect(push.nativePushSnapshot().status).toBeNull();finish({tab:"direct"});await rejection;
    expect(await push.consumeNativePushDestination()).toBeNull();
  });
  it("unbinds a timed-out session and ignores its later registration callbacks",async () => {
    vi.useFakeTimers();
    let finish!:()=>void;
    mock.request.mockResolvedValue(new Response(JSON.stringify({available:true,binding:null,preferences:{...DEFAULT_NATIVE_PUSH_PREFERENCES,enabled:true}})));
    mock.register.mockImplementationOnce(() => new Promise<void>((resolve) => {finish=resolve;}));
    const push=await import("./nativePush.js");const unbind=push.bindNativePushSession("a","csrf-a");
    await vi.advanceTimersByTimeAsync(30_001);expect(push.nativePushSnapshot().error).toContain("still waiting");
    unbind();finish();await vi.advanceTimersByTimeAsync(0);
    mock.handlers.get("registration")!({value:"a".repeat(64)});await vi.advanceTimersByTimeAsync(0);
    expect(push.nativePushSnapshot().status).toBeNull();expect(mock.request.mock.calls.some(([url]) => String(url).endsWith("/register"))).toBe(false);
  });
  it("does not retry a stale preference revision or turn a conflict into successful enablement",async () => {
    const status={available:true,binding:null,preferences:DEFAULT_NATIVE_PUSH_PREFERENCES};
    mock.request.mockImplementation(async (url:URL) => new Response(JSON.stringify(url.pathname.endsWith("/preferences") ? {error:{message:"Notification settings changed. Refresh and try again."}} : status),{status:url.pathname.endsWith("/preferences") ? 409:200}));
    const push=await import("./nativePush.js");push.bindNativePushSession("a","csrf");
    await vi.waitFor(() => expect(push.nativePushSnapshot().status).not.toBeNull());await push.enableNativePush();
    expect(mock.register).not.toHaveBeenCalled();expect(push.nativePushSnapshot().error).toContain("Refresh");
    expect(mock.request.mock.calls.filter(([url]) => String(url).endsWith("/preferences"))).toHaveLength(1);
  });
  it("preserves existing account quiet-hour timezone when enabling another device",async () => {
    const status={available:true,binding:null,preferences:{...DEFAULT_NATIVE_PUSH_PREFERENCES,revision:4,timeZone:"Pacific/Auckland",quietStart:1320,quietEnd:480}};
    mock.request.mockImplementation(async () => new Response(JSON.stringify(status)));
    const push=await import("./nativePush.js");push.bindNativePushSession("a","csrf");
    await vi.waitFor(() => expect(push.nativePushSnapshot().status).not.toBeNull());await push.enableNativePush();
    const write=mock.request.mock.calls.find(([url]) => String(url).endsWith("/preferences"));
    expect(JSON.parse(write![1].body)).toMatchObject({revision:4,timeZone:"Pacific/Auckland",quietStart:1320,quietEnd:480});
  });
});
