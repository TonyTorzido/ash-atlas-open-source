import {
  appearanceAssetParts,
  bossAppearanceAssetKeys,
  parseBossAppearanceCatalog,
  parsePlayerAppearanceCatalog
} from "../../packages/shared/src/index.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePng } from "../../apps/appearance-studio/src/pngValidation.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const assetRoot = await realpath(path.join(
  repositoryRoot,
  "packages/player-renderer/src/assets/player-appearance"
));
const catalogPath = path.join(
  repositoryRoot,
  "packages/shared/src/data/player-appearance-catalog.json"
);
const catalog = parsePlayerAppearanceCatalog(
  JSON.parse(await readFile(catalogPath, "utf8"))
);
const bossAssetRoot = await realpath(path.join(
  repositoryRoot,
  "packages/player-renderer/src/assets/boss-appearance"
));
const bossCatalogPath = path.join(
  repositoryRoot,
  "packages/shared/src/data/boss-appearance-catalog.json"
);
const bossCatalog = parseBossAppearanceCatalog(
  JSON.parse(await readFile(bossCatalogPath, "utf8"))
);
const keys = [
  ...catalog.appearances.flatMap((appearance) =>
    appearanceAssetParts(appearance).map((part) => part.assetKey)
  ),
  ...catalog.appearances.flatMap((appearance) =>
    appearance.projectileAssetKey ? [appearance.projectileAssetKey] : []
  ),
  ...catalog.bodyVariants.flatMap((body) =>
    [
      ...Object.values(body.bodyAssetKeys ?? {}),
      ...Object.values(body.skinToneAssetKeys ?? {}),
      ...Object.values(body.headAssetKeys ?? {}),
      ...Object.values(body.headSkinToneAssetKeys ?? {})
    ]
      .filter((key): key is string => typeof key === "string")
  ),
  ...Object.values(catalog.enhancementPresentation.gemstoneAssetKeys)
];
for (const key of keys) {
  const candidate = path.resolve(assetRoot, key);
  const relative = path.relative(assetRoot, candidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !candidate.toLowerCase().endsWith(".png")
  ) {
    throw new Error(`Appearance catalog asset key is unsafe: ${key}`);
  }
  validatePng(await readFile(candidate));
}
const bossKeys = bossAppearanceAssetKeys(bossCatalog);
for (const key of bossKeys) {
  const candidate = path.resolve(bossAssetRoot, key);
  const relative = path.relative(bossAssetRoot, candidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !candidate.toLowerCase().endsWith(".png")
  ) {
    throw new Error(`Boss appearance catalog asset key is unsafe: ${key}`);
  }
  validatePng(await readFile(candidate));
}
console.log(
  `Appearance catalogs verified (${keys.length} player assets, ${bossKeys.length} boss assets).`
);
