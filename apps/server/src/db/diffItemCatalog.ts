import pg from "pg";

import { loadConfig } from "../config.js";
import { COMPILED_ITEM_DEFINITIONS } from "../game/items.js";

/**
 * Field-by-field diff of compiled item definitions against item_definitions
 * rows. Usage: tsx src/db/diffItemCatalog.ts [item_id ...] (default: every
 * compiled item that differs). Exits 1 when any listed item differs.
 */
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
const wanted = process.argv.slice(2);

try {
  const { rows } = await pool.query(
    `SELECT item_id, unit_weight_grams, display_name, category, equipment_family_id, equipment_role, rarity,
            droppable, manor_storable, market_tradable, market_fungible, market_identity, supported_variants
     FROM item_definitions ORDER BY item_id`
  );
  let differing = 0;
  for (const row of rows) {
    const compiled = COMPILED_ITEM_DEFINITIONS.get(row.item_id);
    if (!compiled || (wanted.length > 0 && !wanted.includes(row.item_id))) continue;
    const pairs: Array<[string, unknown, unknown]> = [
      ["unit_weight_grams", row.unit_weight_grams, compiled.unitWeightGrams],
      ["display_name", row.display_name, compiled.displayName],
      ["category", row.category, compiled.category],
      ["equipment_family_id", row.equipment_family_id, compiled.equipmentFamilyId],
      ["equipment_role", row.equipment_role, compiled.equipmentRole],
      ["rarity", row.rarity, compiled.rarity],
      ["droppable", row.droppable, compiled.droppable],
      ["manor_storable", row.manor_storable, compiled.manorStorable],
      ["market_tradable", row.market_tradable, compiled.marketTradable],
      ["market_fungible", row.market_fungible, compiled.marketFungible],
      ["market_identity", row.market_identity, compiled.marketIdentity],
      ["supported_variants", [...row.supported_variants].sort(), [...compiled.supportedVariants].sort()]
    ];
    const diffs = pairs.filter(([, db, code]) => JSON.stringify(db) !== JSON.stringify(code));
    if (diffs.length === 0) continue;
    differing += 1;
    for (const [field, db, code] of diffs)
      process.stdout.write(`${row.item_id}.${field}: db=${JSON.stringify(db)} compiled=${JSON.stringify(code)}\n`);
  }
  process.stdout.write(`${differing} item(s) differ\n`);
  process.exitCode = differing > 0 ? 1 : 0;
} finally {
  await pool.end();
}
