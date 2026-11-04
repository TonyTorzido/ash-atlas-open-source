# Player wiki art backlog

Art the player wiki (`apps/client/src/wiki`) still needs. Until each piece lands, the wiki
shows an empty, correctly sized art slot — never a placeholder graphic.

## Monster art

| Monster | Archetype key | Target |
|---|---|---|
| Bandit | `bandit` | Match the existing creature art |
| Orc Brute | `orc_brute` | Match the existing creature art |
| Slime | `slime` | Match the existing creature art |
| Slime Miniboss | `slime_miniboss` | Match the existing creature art |

Spec: transparent PNG with the same rendering style, scale, framing, and proportions as the
creature art already in `apps/client/src/assets` — `wolf.png`, `ogre.png`, and
`goblins/goblin-basic.png`. Same painterly finish, lighting direction, outline weight, and
padding; the creature should read at the same on-screen size as those references. A first
batch was rejected because it did not match that style.

Wiring: monster art is wiki-only until approved for the game; add it through
`apps/client/src/wiki/wikiArt.tsx` (`monsterArtSource`), not the in-game `map/mobArtwork.ts`.

## Weapon icon

| Icon | Matchup type | Target |
|---|---|---|
| Martial Arts | `martial_arts` | 256×256 transparent PNG |

Spec: match `apps/client/src/assets/items/sword.png` (rendering, three-quarter angle,
lighting, padding). Wire it into `MATCHUP_TYPE_ICONS` in `apps/client/src/wiki/wikiArt.tsx`
as an optimized WebP under `apps/client/src/wiki/assets/items/`.

## Home hero

The current hero (`apps/client/public/landing/ash-atlas-landing-desktop.webp`, 1672×941)
carries a mosaic texture that reads as blocky at large sizes.

- Desktop: clean 3840×2160 WebP, no mosaic texture, same composition (banner on the right;
  keep the left half calm enough for the title overlay).
- Phone: 1440×2560 WebP crop of the same scene, subject kept clear of the lower third
  where the title and buttons sit.
