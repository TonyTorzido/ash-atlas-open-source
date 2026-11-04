export const DEVELOPMENT_PROFILE_KEYS = ["default", "player2", "player3", "player4"] as const;

export type DevelopmentProfileKey = (typeof DEVELOPMENT_PROFILE_KEYS)[number];

type DevelopmentProfile = {
  subject: string;
  email: string;
  displayName: string;
  /** Preset player setup so local dev logins skip the create-player screen. */
  personalFlagColor: string;
};

const ADDITIONAL_DEVELOPMENT_PROFILES: Record<
  Exclude<DevelopmentProfileKey, "default">,
  DevelopmentProfile
> = {
  player2: {
    subject: "ash-atlas-dev:player2",
    email: "devplayer2@example.com",
    displayName: "DevTwo",
    personalFlagColor: "blue"
  },
  player3: {
    subject: "ash-atlas-dev:player3",
    email: "devplayer3@example.com",
    displayName: "DevThree",
    personalFlagColor: "green"
  },
  player4: {
    subject: "ash-atlas-dev:player4",
    email: "devplayer4@example.com",
    displayName: "DevFour",
    personalFlagColor: "gold"
  }
};

export function isDevelopmentProfileKey(value: unknown): value is DevelopmentProfileKey {
  return typeof value === "string" && DEVELOPMENT_PROFILE_KEYS.includes(value as DevelopmentProfileKey);
}

export function developmentProfile(
  key: DevelopmentProfileKey,
  defaultEmail: string,
  defaultDisplayName: string
): DevelopmentProfile {
  if (key === "default") {
    const email = defaultEmail.trim().toLowerCase();
    return {
      // Preserve the original single-account development identity and all of its existing data.
      subject: `ash-atlas-dev:${email}`,
      email,
      displayName: defaultDisplayName,
      personalFlagColor: "red"
    };
  }
  return ADDITIONAL_DEVELOPMENT_PROFILES[key];
}
