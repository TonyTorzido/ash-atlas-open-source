export const HARVEST_ACCESS_MODES = ["private", "public"] as const;
export type HarvestAccessMode = (typeof HARVEST_ACCESS_MODES)[number];

export const HARVEST_TOLL_TYPES = [
  "stone_mine",
  "coal_mine",
  "iron_mine",
  "sulfur_mine",
  "oil_well"
] as const;
export type HarvestTollType = (typeof HARVEST_TOLL_TYPES)[number];

export const MINE_CLAIM_COST = Object.freeze({ stone: 3, wood: 10 });

export type HarvestTollSetting = Readonly<{
  harvestType: HarvestTollType;
  tollGold: string;
  revision: string;
}>;

export type HarvestAccessAsset = Readonly<{
  assetId: string;
  harvestType: HarvestTollType;
  label: string;
  accessMode: HarvestAccessMode;
  accessRevision: string;
}>;

export type HarvestTollsSnapshot = Readonly<{
  settings: HarvestTollSetting[];
  assets: HarvestAccessAsset[];
}>;
