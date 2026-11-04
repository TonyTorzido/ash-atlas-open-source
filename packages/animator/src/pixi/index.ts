/*
 * Atlas Animator: original implementation (clean-room, see docs/plans/atlas-animator.md section 2).
 *
 * Public surface of the Pixi 8 adapter (`@ash-atlas/animator/pixi`): the character renderer, the
 * dynamic atlas, image providers and debug overlays. The game, the editor and the CLI's headless
 * renders all draw through this module, so a preview is exactly what the game shows.
 */
export * from "./imageOps.js";
export * from "./shelfAllocator.js";
export * from "./dynamicAtlas.js";
export * from "./partImages.js";
export * from "./browserImages.js";
export * from "./animatorCharacter.js";
export * from "./debugOverlay.js";
