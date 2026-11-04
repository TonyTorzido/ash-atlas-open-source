// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api=vi.hoisted(() => ({ getSession:vi.fn(),logout:vi.fn(),completeOnboarding:vi.fn(),pending:false }));
vi.mock("../auth/authClient.js",() => ({ AuthApiClient:class { getSession=api.getSession; logout=api.logout; completeOnboarding=api.completeOnboarding; },AuthApiError:class extends Error {} }));
vi.mock("../native/nativeLogout.js",() => ({ initializeNativeLogout:async () => {},NativeLogoutPersistenceError:class extends Error {},nativeLogoutPending:() => api.pending,setNativeLogoutPending:async (value:boolean) => { api.pending=value; } }));
vi.mock("../native/nativePush.js",() => ({ clearNativePushForLogout:vi.fn(async () => {}) }));
vi.mock("../native/nativeRequest.js",() => ({ nativeAuthNeedsReconciliation:() => false }));
vi.mock("../native/nativeApp.js",() => ({ isNativeApp:() => true,readNativeAuthorizationRequest:() => null,refreshNativeWebSocketProtocols:vi.fn(),beginNativeBrowserAuthorization:vi.fn(),nativeAuthorizationEndpoint:vi.fn() }));
vi.mock("./PlayerNameScreen.js",() => ({ PlayerNameScreen:({ onSubmit,onLogout }:{onSubmit:(name:string,color:string)=>Promise<void>;onLogout:()=>Promise<void>}) => <><button onClick={() => void onSubmit("Scout","red")}>Create</button><button onClick={() => void onLogout()}>Sign out</button></> }));
import { AuthGate } from "./AuthGate.js";
const session={ authenticated:true,account:{id:"account",status:"active"},player:{id:"player",displayName:"Scout",personalFlagColor:"red"},csrfToken:"csrf",testAccessStatus:"approved",onboardingRequired:false,developmentAuthEnabled:false };
beforeEach(() => { vi.clearAllMocks();api.pending=false; });
afterEach(cleanup);
describe("native account generation fence",() => {
  it("never remounts gameplay when onboarding resolves after offline logout",async () => {
    api.getSession.mockResolvedValueOnce({...session,player:null,onboardingRequired:true}).mockImplementation(() => new Promise(() => {}));
    api.logout.mockImplementation(() => new Promise(() => {}));
    let complete!:(value:unknown)=>void;
    api.completeOnboarding.mockImplementation(() => new Promise((resolve) => { complete=resolve; }));
    const game=vi.fn(() => <p>Gameplay</p>);
    render(<AuthGate renderGame={game}/>);
    await screen.findByText("Create");
    fireEvent.click(screen.getByText("Create"));
    fireEvent.click(screen.getByText("Sign out"));
    await act(async () => { complete(session.player); });
    expect(api.pending).toBe(true);
    expect(game).not.toHaveBeenCalled();
    expect(screen.queryByText("Gameplay")).toBeNull();
  });
  it("discards a session-ended read that resolves after logout",async () => {
    api.getSession.mockResolvedValueOnce(session);
    let complete!:(value:unknown)=>void;
    api.getSession.mockImplementationOnce(async () => session).mockImplementation(() => new Promise((resolve) => { complete=resolve; }));
    api.logout.mockImplementation(() => new Promise(() => {}));
    let controls!:Parameters<Parameters<typeof AuthGate>[0]["renderGame"]>[0];
    const game=vi.fn((input:typeof controls) => { controls=input;return <p>Gameplay</p>; });
    render(<AuthGate renderGame={game}/>);
    await screen.findByText("Gameplay");
    api.getSession.mockReset().mockImplementation(() => new Promise((resolve) => { complete=resolve; }));
    act(() => controls.onSessionEnded("SESSION_EXPIRED"));
    act(() => { void controls.onLogout(); });
    const renders=game.mock.calls.length;
    await act(async () => { complete(session); });
    expect(api.pending).toBe(true);
    expect(game).toHaveBeenCalledTimes(renders);
    expect(screen.queryByText("Gameplay")).toBeNull();
  });
});
