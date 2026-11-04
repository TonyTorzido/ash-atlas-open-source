// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api=vi.hoisted(() => ({ getSession:vi.fn(),logout:vi.fn(),native:false,authorizationRequest:null as unknown }));
vi.mock("../auth/authClient.js",() => ({ AuthApiClient:class { getSession=api.getSession; logout=api.logout; },AuthApiError:class extends Error {} }));
vi.mock("../native/nativeLogout.js",() => ({ initializeNativeLogout:async () => {},NativeLogoutPersistenceError:class extends Error {},nativeLogoutPending:() => false,setNativeLogoutPending:async () => {} }));
vi.mock("../native/nativePush.js",() => ({ clearNativePushForLogout:vi.fn(async () => {}) }));
vi.mock("../native/nativeRequest.js",() => ({ nativeAuthNeedsReconciliation:() => false }));
vi.mock("../native/nativeApp.js",() => ({ isNativeApp:() => api.native,nativePlatform:() => api.native ? "android" : null,readNativeAuthorizationRequest:() => api.authorizationRequest,refreshNativeWebSocketProtocols:vi.fn(),beginNativeBrowserAuthorization:vi.fn(),nativeAuthorizationEndpoint:vi.fn(() => "about:blank") }));
vi.mock("./LoginScreen.js",() => ({ LoginScreen:() => <p>Sign-in options</p> }));
vi.mock("../pwa/PwaInstallPrompt.js",() => ({ PwaInstallPrompt:() => null }));
import { AuthGate } from "./AuthGate.js";

const signedOut=(mode:"open"|"dev") => ({ authenticated:false,csrfToken:"",developmentAuthEnabled:false,developerCapabilities:[],testAccessMode:mode });
const developer={ authenticated:true,account:{id:"account",status:"active"},player:{id:"player",displayName:"Dev",personalFlagColor:"red"},csrfToken:"csrf",testAccessStatus:"approved",testAccessAllowed:true,onboardingRequired:false,developmentAuthEnabled:false,developerCapabilities:[] };
const heldOut={ ...developer,testAccessAllowed:false,testAccessDevOnly:true,verifiedEmail:"player@example.com" };
const game=vi.fn(() => <p>Gameplay</p>);

beforeEach(() => { vi.clearAllMocks();api.native=false;api.authorizationRequest=null; });
afterEach(cleanup);

describe("auth gate update sign-up",() => {
  it("shows the update sign-up instead of sign-in in dev mode, with a quiet developer sign-in",async () => {
    api.getSession.mockResolvedValue(signedOut("dev"));
    render(<AuthGate renderGame={game}/>);
    await screen.findByText("Major upgrades in progress");
    expect(screen.queryByText("Sign-in options")).toBeNull();
    fireEvent.click(screen.getByRole("button",{ name:"Developer sign-in" }));
    expect(await screen.findByText("Sign-in options")).toBeTruthy();
    expect(screen.queryByText("Major upgrades in progress")).toBeNull();
  });

  it("keeps normal sign-in in open mode",async () => {
    api.getSession.mockResolvedValue(signedOut("open"));
    render(<AuthGate renderGame={game}/>);
    expect(await screen.findByText("Sign-in options")).toBeTruthy();
    expect(screen.queryByText("Major upgrades in progress")).toBeNull();
  });

  it("lets a signed-in developer straight into the game",async () => {
    api.getSession.mockResolvedValue(developer);
    render(<AuthGate renderGame={game}/>);
    expect(await screen.findByText("Gameplay")).toBeTruthy();
    expect(screen.queryByText("Major upgrades in progress")).toBeNull();
  });

  it("shows a signed-in non-developer the sign-up with their account and sign out",async () => {
    api.native=true;
    api.getSession.mockResolvedValue(heldOut);
    render(<AuthGate renderGame={game}/>);
    await screen.findByText("Major upgrades in progress");
    expect(screen.getByText("player@example.com")).toBeTruthy();
    expect(screen.getByRole("button",{ name:"Sign out" })).toBeTruthy();
    expect(game).not.toHaveBeenCalled();
  });

  it("submits from the app with the platform source",async () => {
    api.native=true;
    api.getSession.mockResolvedValue(signedOut("dev"));
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("{}",{ status:200 }));
    render(<AuthGate renderGame={game}/>);
    fireEvent.change(await screen.findByLabelText("Email address"),{ target:{ value:"fan@example.com" } });
    fireEvent.click(screen.getByRole("button",{ name:"Notify me" }));
    expect(await screen.findByText(/on the list/u)).toBeTruthy();
    const init=fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ email:"fan@example.com",source:"app-android" });
    fetchMock.mockRestore();
  });
});
