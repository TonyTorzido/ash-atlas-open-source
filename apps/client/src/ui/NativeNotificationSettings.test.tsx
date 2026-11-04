// @vitest-environment jsdom
import { cleanup,render,screen } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { DEFAULT_NATIVE_PUSH_PREFERENCES, type NativePushStatus } from "@ash-atlas/shared";
const state=vi.hoisted(() => ({permission:"denied",busy:false,error:null as string|null,status:null as NativePushStatus | null}));
vi.mock("../native/nativePush.js",async () => {
  const shared=await import("@ash-atlas/shared");
  return {DEFAULT_NATIVE_PUSH_PREFERENCES:shared.DEFAULT_NATIVE_PUSH_PREFERENCES,nativePushSnapshot:() => state,subscribeNativePush:() => () => {},refreshNativePush:vi.fn(),disableNativePush:vi.fn(),enableNativePush:vi.fn(),saveNativePushPreferences:vi.fn(),openNativeNotificationSettings:vi.fn()};
});
import { NativeNotificationSettings } from "./NativeNotificationSettings.js";
afterEach(cleanup);
it("does not call a denied device enabled and offers the system Settings path",() => {
  state.status={available:true,binding:{epoch:1,tokenVersion:1,enabled:true},preferences:{...DEFAULT_NATIVE_PUSH_PREFERENCES,enabled:true}};
  render(<NativeNotificationSettings/>);
  expect(screen.getByRole("status").textContent).toContain("blocked in device Settings");
  expect(screen.getByRole("button",{name:"Open notification settings"})).toBeDefined();
});
