import type { ReactNode } from "react";

const CLASS_ABILITY_ICONS: Readonly<Record<string, ReactNode>> = Object.freeze({
  warrior_v2_sundering_arc: <><path d="M5 19 17 7M14 5l5 5M4 20l4-1-3-3-1 4Z"/><path d="m5 7 1.5-3L8 7l3 1.5L8 10l-1.5 3L5 10 2 8.5 5 7Z"/></>,
  warrior_v2_iron_reversal: <><path d="M12 21s7-4 7-10V5l-7-2-7 2v6c0 6 7 10 7 10Z"/><path d="m8 12 3 3 5-6"/></>,
  warrior_v2_faultline: <><path d="m5 19 8-8M11 5l3-2 5 5-2 3-6-6ZM4 20l3-1-2-2-1 3Z"/><path d="M16 15h.01M20 13h.01M19 18h.01"/></>,
  warrior_v2_rallying_roar: <><path d="M4 10v4l4 1 7 4V5L8 9l-4 1Z"/><path d="m8 15 1 5h3l-1-4M18 8c1 1 1 7 0 8M21 6c2 3 2 9 0 12"/></>,
  warrior_v2_worldbreaker: <><circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5 19 19M19 5l-3.5 3.5M8.5 15.5 5 19"/></>,

  ranger_v2_throughshot: <><path d="M4 20 20 4M14 4h6v6M4 14v6h6"/><path d="M6 6c4 3 9 8 12 12"/></>,
  ranger_v2_threefold_volley: <><path d="M4 9h13M14 6l3 3-3 3M7 15h13M17 12l3 3-3 3"/></>,
  ranger_v2_marked_quarry: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></>,
  ranger_v2_snare_shot: <><path d="M3 8h14M14 5l3 3-3 3"/><path d="M9 14c2-2 4-2 6 0l3 3M8 19l3-3M15 14l-2 5"/></>,
  ranger_v2_black_rain: <><path d="M4 8c2-4 14-4 16 0"/><path d="m6 12-1 3M10 11l-1 5M14 11l1 5M18 12l1 3"/><path d="M3 19h18"/></>,

  ninja_v2_twin_fang: <><path d="M5 20 15 6l2 5 3 2L5 20Z"/><path d="M4 15 12 4l1 4"/></>,
  ninja_v2_smoke_bomb: <><circle cx="12" cy="15" r="3"/><path d="M5 17c-3-2-1-6 2-6-1-4 5-6 7-3 4-2 7 3 4 6 3 1 2 5-1 6"/></>,
  ninja_v2_shadowstep: <><path d="M4 18c5 0 7-4 7-8M7 7l4 3-4 3"/><path d="M14 6h6M14 11h4M14 16h6"/></>,
  ninja_v2_shuriken_fan: <><path d="m12 3 2.5 6 6.5 1-5 4 1.5 7-5.5-4-5.5 4 1.5-7-5-4 6.5-1L12 3Z"/><circle cx="12" cy="12" r="2"/></>,
  ninja_v2_thousand_shadows: <><path d="M4 19c3-7 5-10 8-14M9 20c2-7 4-11 7-15M15 20c1-5 3-8 5-11"/><path d="M3 14h5M8 10h5M13 8h5"/></>
});

export const CLASS_ABILITY_ICON_IDS = Object.freeze(Object.keys(CLASS_ABILITY_ICONS));

export function hasClassAbilityIcon(abilityId: string): boolean {
  return abilityId in CLASS_ABILITY_ICONS;
}

export function ClassAbilityIcon({ abilityId, className }: {
  abilityId: string | null;
  className?: string;
}): React.JSX.Element {
  const icon = abilityId ? CLASS_ABILITY_ICONS[abilityId] : null;
  return <svg
    className={className}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    data-class-ability-icon={abilityId ?? "empty"}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >{icon ?? <><path d="M12 6v12M6 12h12"/></>}</svg>;
}
