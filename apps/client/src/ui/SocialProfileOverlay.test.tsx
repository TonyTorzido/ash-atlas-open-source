import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PublicProfile } from "@ash-atlas/shared";
import {
  CompactProfile,
  FriendActions,
  ProfileBiography,
  ProfileHeader,
  ProfileSummary,
  ProfileSlots,
  mayInviteProfileToKingdom
} from "./SocialProfileOverlay.js";

describe("profile UI", () => {
  it("uses the canonical shell and keeps the character and identity panel side by side", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(`${directory}/SocialProfileOverlay.tsx`, "utf8");
    const theme = readFileSync(`${directory}/../ashAtlasTheme.css`, "utf8");
    expect(source).toContain("<GameAppShell");
    expect(source).toContain('<section className="profile-hero"');
    expect(source).toContain("<RigPortrait");
    expect(theme).toMatch(/\.profile-hero\s*\{[^}]*grid-template-columns: minmax\(220px, 32%\) minmax\(0, 1fr\);/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.profile-hero\s*\{[^}]*grid-template-columns: minmax\(124px, 40%\) minmax\(0, 1fr\);/s);
  });

  it("renders compact map selection fields and the View Profile action", () => {
    const html = renderToStaticMarkup(<CompactProfile profile={profile()} onExpand={() => undefined} />);
    expect(html).toContain("Target");
    // No active class (or a hidden old one) shows the level alone, never a default class.
    expect(html).toContain("Level 7</div>");
    expect(html).not.toContain("Warrior");
    expect(html).toContain("Kingdom");
    expect(html).toContain("Home");
    expect(html).toContain("View Profile");
  });

  it("renders the character summary, membership details, and relationship actions", () => {
    const target = profile({
      settlement: { id: "city", name: "Ciudad de México" },
      class: { id: "ronin", name: "Ronin" },
      relationship: { friendship: "incoming_request", enemyMarkedByViewer: false }
    });
    const html = renderToStaticMarkup(<>
      <ProfileHeader profile={target} />
      <ProfileSummary profile={target} />
      <ProfileSlots profile={target} />
      <FriendActions profile={target} busy={false} mutate={vi.fn()} />
    </>);
    expect(html).toContain("Target");
    expect(html).toContain("Level");
    expect(html).toContain("Ronin · Level 7");
    expect(html).not.toContain("KD");
    expect(html).toContain("Kingdom");
    expect(html).toContain("None");
    expect(html).toContain("Playing Since");
    expect(html).toContain("Ciudad de México");
    expect(html).not.toContain("profile-portrait");
    expect(html).toContain("Accept");
    expect(html).toContain("Decline");
  });

  it("renders biography text as escaped plain text, never executable HTML", () => {
    const html = renderToStaticMarkup(<ProfileBiography biography={'<script>alert("x")</script>'} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not offer friend actions for private enemy or unavailable states", () => {
    const enemy = renderToStaticMarkup(<FriendActions
      profile={profile({ relationship: { friendship: "none", enemyMarkedByViewer: true } })}
      busy={false}
      mutate={vi.fn()}
    />);
    expect(enemy).not.toContain("Add Friend");
    const unavailable = renderToStaticMarkup(<FriendActions
      profile={profile({ relationship: { friendship: "unavailable", enemyMarkedByViewer: false } })}
      busy={false}
      mutate={vi.fn()}
    />);
    expect(unavailable).toContain("Relationship actions unavailable");
  });

  it("renders requester and recipient neutrality actions without unilateral enemy removal", () => {
    const requester = renderToStaticMarkup(<FriendActions
      profile={profile({ relationship: {
        friendship: "none",
        enemyMarkedByViewer: true,
        neutralityRequest: "outgoing"
      } })}
      busy={false}
      mutate={vi.fn()}
    />);
    expect(requester).toContain("Neutrality Requested");
    expect(requester).toContain('class="profile-action-status"');
    expect(requester).not.toContain(">Neutrality Requested</button>");
    expect(requester).toContain("Cancel");
    expect(requester).not.toContain("Remove Enemy");

    const recipient = renderToStaticMarkup(<FriendActions
      profile={profile({ relationship: {
        friendship: "none",
        enemyMarkedByViewer: true,
        neutralityRequest: "incoming"
      } })}
      busy={false}
      mutate={vi.fn()}
    />);
    expect(recipient).toContain("Accept Neutrality");
    expect(recipient).toContain("Reject");
  });

  it("offers profile-based Kingdom invitations only to eligible unaffiliated targets", () => {
    expect(mayInviteProfileToKingdom(profile(), { allowed: true })).toBe(true);
    expect(mayInviteProfileToKingdom(profile({ isSelf: true }), { allowed: true })).toBe(false);
    expect(mayInviteProfileToKingdom(profile({
      kingdom: { id: "kingdom", name: "Taken", emblemKey: null, memberRole: "member" }
    }), { allowed: true })).toBe(false);
    expect(mayInviteProfileToKingdom(profile(), { allowed: false })).toBe(false);
  });
});

function profile(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    playerId: "target",
    displayName: "Target",
    level: 7,
    portrait: { kind: "player_sprite", displayColor: "#123456" },
    title: "Alpha Tester",
    biography: "Bio",
    presence: "online",
    class: null,
    kingdom: null,
    settlement: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    isSelf: false,
    relationship: { friendship: "none", enemyMarkedByViewer: false },
    ...overrides
  };
}
