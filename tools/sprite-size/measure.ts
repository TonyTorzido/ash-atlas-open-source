import { relative } from "node:path";

import { measureSpriteSizes } from "../../apps/client/src/developer/spriteVisibleSize.js";

/**
 * Prints canvas size, opaque fill, baseHeightPx and visible height for every mob, pet and boss
 * sprite. Usage: pnpm sprite:sizes [substring filter] [--json]
 */
const args = process.argv.slice(2);
const json = args.includes("--json");
const filter = args.find((arg) => !arg.startsWith("--"))?.toLowerCase();
const rows = measureSpriteSizes()
  .filter((row) => !filter || row.artKey.toLowerCase().includes(filter) || row.file.toLowerCase().includes(filter))
  .sort((a, b) => a.visibleHeightPx - b.visibleHeightPx);

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log("group  artKey                      presentation          canvas      fillH fillW  base  visible");
  for (const row of rows) {
    console.log([
      row.group.padEnd(6),
      row.artKey.padEnd(27),
      row.presentationKey.padEnd(21),
      `${row.width}x${row.height}`.padEnd(11),
      row.fillHeight.toFixed(2).padStart(5),
      row.fillWidth.toFixed(2).padStart(5),
      row.baseHeightPx.toFixed(1).padStart(6),
      row.visibleHeightPx.toFixed(1).padStart(7),
      relative(process.cwd(), row.file).replaceAll("\\", "/").replace("apps/client/src/assets/", "")
    ].join(" "));
  }
}
