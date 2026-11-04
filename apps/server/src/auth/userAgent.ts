export type BroadClientProfile = {
  browserFamily: string;
  osFamily: string;
};

export function broadClientProfile(userAgent: string | undefined): BroadClientProfile {
  const value = userAgent ?? "";
  const browserFamily = /Edg\//i.test(value)
    ? "Edge"
    : /Firefox\//i.test(value)
      ? "Firefox"
      : /Chrome\//i.test(value)
        ? "Chrome"
        : /Safari\//i.test(value)
          ? "Safari"
          : "Other";
  const osFamily = /Windows/i.test(value)
    ? "Windows"
    : /Android/i.test(value)
      ? "Android"
      : /iPhone|iPad/i.test(value)
        ? "iOS"
        : /Mac OS/i.test(value)
          ? "macOS"
          : /Linux/i.test(value)
            ? "Linux"
            : "Other";
  return { browserFamily, osFamily };
}
