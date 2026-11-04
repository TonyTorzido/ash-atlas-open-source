// The store binary ships a seed bundle instead of the full client: all code,
// styles, and data, plus only the art the seed itself shows. A seed never
// renders the game; on first launch it asks before downloading the current
// signed live-update bundle and reloads into it (main.tsx). The full bundle
// arrives through the same per-file manifest as every OTA update, so files the
// seed already holds are copied instead of downloaded.
//
// The seed shows only the boot screens (index.html's first frame and
// BootScreen), which use the root-level app icons. Every image below the root
// (hashed imports in assets/, public art packs such as assets/dungeons/,
// brand/, landing/) stays out of the seed.
//
// Later on-demand packs hook in here: a pack (for example "assets/dungeons/")
// would get its own class next to "seed" and "full", be left out of the full
// live-update manifest by writeNativeLiveUpdateManifest.mjs, and be fetched by
// the client when first needed. Nothing builds or fetches packs yet.
export type NativeBundleFileClass = "seed" | "full";

// Images and audio below the root are heavy art-pack files, not seed files.
const IMAGE_FILE = /\.(?:png|webp|jpe?g|gif|avif|m4a|mp3|ogg|wav)$/iu;

export function nativeBundleFileClass(href: string): NativeBundleFileClass {
  if (!IMAGE_FILE.test(href)) return "seed";
  return href.includes("/") ? "full" : "seed";
}
