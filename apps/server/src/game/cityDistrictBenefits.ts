import {
  CITY_DISTRICT_GATHERING_CHANCE_BY_TIER,
  CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
  CITY_MARKET_STANDARD_BUYER_TAX_BPS,
  EMPTY_CITY_DISTRICT_BENEFIT,
  type CityDistrictBenefitSnapshot,
  type CityDistrictType,
  type CityMonumentTier,
  type MarketTaxTag
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type BenefitRow = {
  city_id: string;
  district_revision: string;
  district_type: CityDistrictType | null;
  monument_tier: CityMonumentTier | null;
};

export type CityMarketTaxAuthority = Readonly<{
  cityId: string;
  districtType: CityDistrictType | null;
  monumentTier: CityMonumentTier | null;
  taxRevision: string;
  buyerTaxBps: number;
  specialtyApplied: boolean;
  qualifyingTaxTag: MarketTaxTag | null;
}>;

const DISTRICT_TAX_TAGS: Readonly<Record<CityDistrictType, readonly MarketTaxTag[]>> = {
  mining: ["mining"],
  forestry: ["forestry"],
  hunting: ["hunting"]
};

export class CityDistrictBenefitService {
  private readonly runtimeByPlayer = new Map<
    string,
    CityDistrictBenefitSnapshot
  >();

  constructor(private readonly pool: pg.Pool) {}

  async resolveForPlayer(
    queryable: Queryable,
    playerId: string
  ): Promise<CityDistrictBenefitSnapshot> {
    const result = await queryable.query<BenefitRow>(
      `WITH member_city AS (
         SELECT city.id, city.district_revision
         FROM city_memberships membership
         JOIN cities city
           ON city.id = membership.city_id
          AND city.active
         WHERE membership.player_id = $1
           AND membership.left_at IS NULL
         ORDER BY membership.joined_at DESC
         LIMIT 1
       )
       SELECT city.id::text AS city_id,
              city.district_revision::text,
              monument.district_type,
              monument.tier AS monument_tier
       FROM member_city city
       LEFT JOIN city_structures monument
         ON monument.city_id = city.id
        AND monument.structure_type = 'monument'
        AND monument.state = 'active'
        AND monument.district_type IN ('mining', 'forestry', 'hunting')
       ORDER BY monument.district_type`,
      [playerId]
    );
    return result.rows.length > 0
      ? snapshotFromRows(result.rows)
      : EMPTY_CITY_DISTRICT_BENEFIT;
  }

  async refreshRuntime(playerId: string): Promise<CityDistrictBenefitSnapshot> {
    const snapshot = await this.resolveForPlayer(this.pool, playerId);
    this.runtimeByPlayer.set(playerId, snapshot);
    return snapshot;
  }

  stageRuntime(
    playerId: string,
    snapshot: CityDistrictBenefitSnapshot
  ): void {
    this.runtimeByPlayer.set(playerId, snapshot);
  }

  clearRuntime(playerId: string): void {
    this.runtimeByPlayer.delete(playerId);
  }

  runtimeSnapshot(playerId: string): CityDistrictBenefitSnapshot {
    return this.runtimeByPlayer.get(playerId) ?? EMPTY_CITY_DISTRICT_BENEFIT;
  }

  async refreshCityRuntime(cityId: string): Promise<void> {
    const members = await this.pool.query<{ player_id: string }>(
      `SELECT player_id
       FROM city_memberships
       WHERE city_id = $1 AND left_at IS NULL`,
      [cityId]
    );
    await Promise.all(
      members.rows.map(({ player_id }) => this.refreshRuntime(player_id))
    );
  }

  async resolveMarketTax(
    queryable: Queryable,
    venueId: string,
    itemTaxTags: readonly MarketTaxTag[]
  ): Promise<CityMarketTaxAuthority> {
    const result = await queryable.query<{
      city_id: string;
      district_type: CityDistrictType | null;
      monument_tier: CityMonumentTier | null;
      tax_revision: string;
    }>(
      `SELECT venue.city_id::text,
              monument.district_type,
              monument.tier AS monument_tier,
              venue.tax_revision::text
       FROM market_venues venue
       JOIN cities city ON city.id = venue.city_id AND city.active
       LEFT JOIN city_structures monument
        ON monument.city_id = city.id
        AND monument.structure_type = 'monument'
        AND monument.state = 'active'
        AND monument.district_type IN ('mining', 'forestry', 'hunting')
       WHERE venue.venue_id = $1
         AND venue.scope_type = 'regional'
         AND venue.active
         AND venue.state = 'active'
       FOR SHARE OF venue, city`,
      [venueId]
    );
    const firstRow = result.rows[0];
    if (!firstRow) {
      throw new Error("Active City Market tax authority is unavailable");
    }
    const qualifyingTaxTag = itemTaxTags.find((tag) =>
      result.rows.some((row) =>
        row.district_type !== null && DISTRICT_TAX_TAGS[row.district_type].includes(tag)
      )
    ) ?? null;
    const qualifyingMonument = qualifyingTaxTag === null
      ? null
      : result.rows.find((row) =>
          row.district_type !== null &&
          DISTRICT_TAX_TAGS[row.district_type].includes(qualifyingTaxTag)
        ) ?? null;
    const specialtyApplied = qualifyingMonument !== null;
    return {
      cityId: firstRow.city_id,
      districtType: qualifyingMonument?.district_type ?? null,
      monumentTier: qualifyingMonument?.monument_tier ?? null,
      taxRevision: firstRow.tax_revision,
      buyerTaxBps: specialtyApplied
        ? CITY_MARKET_SPECIALTY_BUYER_TAX_BPS
        : CITY_MARKET_STANDARD_BUYER_TAX_BPS,
      specialtyApplied,
      qualifyingTaxTag
    };
  }
}

function snapshotFromRows(rows: readonly BenefitRow[]): CityDistrictBenefitSnapshot {
  const firstRow = rows[0]!;
  const monumentTiers: Record<CityDistrictType, CityMonumentTier | null> = {
    mining: null,
    forestry: null,
    hunting: null
  };
  for (const row of rows) {
    if (row.district_type !== null && row.monument_tier !== null) {
      monumentTiers[row.district_type] = Number(row.monument_tier) as CityMonumentTier;
    }
  }
  const miningTier = monumentTiers.mining;
  const forestryTier = monumentTiers.forestry;
  const huntingTier = monumentTiers.hunting;
  return {
    cityId: firstRow.city_id,
    monumentTiers,
    districtRevision: String(firstRow.district_revision),
    miningExtraYieldChance: miningTier === null
      ? 0
      : CITY_DISTRICT_GATHERING_CHANCE_BY_TIER[miningTier],
    forestryExtraYieldChance: forestryTier === null
      ? 0
      : CITY_DISTRICT_GATHERING_CHANCE_BY_TIER[forestryTier],
    directMobDamageBonus: huntingTier !== null ? 2 : 0,
    mobDefenseBonus: huntingTier !== null && huntingTier >= 2 ? 2 : 0,
    resinPreservationChance: huntingTier !== null && huntingTier >= 3 ? 0.12 : 0
  };
}
