import buoyColorUrl from "../assets/flags/buoy-color.png";
import buoyHardwareUrl from "../assets/flags/buoy-hardware.png";
import atlasShrineUrl from "../assets/structures/atlas-shrine.png";

export const BUOY_ARTWORK_URLS = {
  color: buoyColorUrl,
  hardware: buoyHardwareUrl,
  canvas: { width: 40, height: 41 }
} as const;

// Pack PNGs remain independent assets. New packs under flags/ need no renderer branch.
const flagUrls = import.meta.glob<string>("../assets/flags/**/*.png", {
  eager: true, query: "?url", import: "default"
});
export const TERRITORY_ARTWORK_URLS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(flagUrls).map(([key, value]) => [
    key.replace("../assets/", "apps/client/src/assets/"), value
  ])),
  "apps/client/src/assets/structures/atlas-shrine.png": atlasShrineUrl
};
