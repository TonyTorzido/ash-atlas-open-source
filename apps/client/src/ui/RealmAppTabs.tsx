import { GameAppTabs } from "./GameAppShell.js";

export type RealmAppSection = "world-map" | "city" | "kingdom";

const REALM_APP_TABS = [
  { id: "world-map", label: "Map" },
  { id: "city", label: "City" },
  { id: "kingdom", label: "Kingdom" }
] as const;

export function RealmAppTabs({
  activeSection,
  onChange,
  disabled = false
}: Readonly<{
  activeSection: RealmAppSection;
  onChange(section: RealmAppSection): void;
  disabled?: boolean;
}>): React.JSX.Element {
  return <div className="realm-app-tabs">
    <GameAppTabs
      variant="housed"
      ariaLabel="Realm sections"
      activeTab={activeSection}
      onChange={(tab) => onChange(tab as RealmAppSection)}
      tabs={REALM_APP_TABS.map((tab) => disabled ? { ...tab, disabled: true } : tab)}
    />
  </div>;
}
