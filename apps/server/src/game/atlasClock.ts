import type pg from "pg";

export const ATLAS_TIME_ZONE = "America/Denver";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type MountainDateTime = {
  date: string;
  time: string;
  offset: string;
  localIso: string;
};

export type MountainWeek = {
  weekStart: string;
  weekStartAt: Date;
  nextWeekStart: string;
  nextWeekStartAt: Date;
};

const mountainFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ATLAS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
  timeZoneName: "longOffset"
});

export class AtlasClock {
  constructor(private readonly nowProvider: () => Date = () => new Date()) {}

  now(): Date {
    return new Date(this.nowProvider().getTime());
  }

  mountainNow(): MountainDateTime {
    return mountainDateTime(this.now());
  }
}

export class PetClock {
  constructor(
    private readonly pool: pg.Pool,
    private readonly atlasClock = new AtlasClock()
  ) {}

  async snapshot(
    playerId: string,
    queryable: Queryable = this.pool
  ): Promise<{
    now: Date;
    real: MountainDateTime;
    effective: MountainDateTime;
    offsetDays: number;
  }> {
    const result = await queryable.query<{ offset_days: number }>(
      `SELECT COALESCE(
         (SELECT offset_days FROM pet_debug_offsets WHERE player_id = $1),
         0
       )::integer AS offset_days`,
      [playerId]
    );
    const offsetDays = Number(result.rows[0]?.offset_days ?? 0);
    const now = this.atlasClock.now();
    const real = mountainDateTime(now);
    const effectiveDate = shiftIsoDate(real.date, offsetDays);
    return {
      now,
      real,
      effective: {
        ...real,
        date: effectiveDate,
        localIso: `${effectiveDate}T${real.time}${real.offset}`
      },
      offsetDays
    };
  }
}

export function mountainDateTime(instant: Date): MountainDateTime {
  const parts = new Map(
    mountainFormatter.formatToParts(instant).map((part) => [part.type, part.value])
  );
  const date = `${required(parts, "year")}-${required(parts, "month")}-${required(parts, "day")}`;
  const time = `${required(parts, "hour")}:${required(parts, "minute")}:${required(parts, "second")}.${required(parts, "fractionalSecond")}`;
  const offset = normalizeOffset(required(parts, "timeZoneName"));
  return { date, time, offset, localIso: `${date}T${time}${offset}` };
}

export function mountainWeek(instant: Date): MountainWeek {
  const localDate = mountainDateTime(instant).date;
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const weekStart = shiftIsoDate(localDate, -daysSinceMonday);
  const nextWeekStart = shiftIsoDate(weekStart, 7);
  return {
    weekStart,
    weekStartAt: mountainMidnight(weekStart),
    nextWeekStart,
    nextWeekStartAt: mountainMidnight(nextWeekStart)
  };
}

export function mountainMidnight(date: string): Date {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new Error("Invalid Mountain calendar date");
  const offset = mountainDateTime(new Date(parsed)).offset;
  const midnight = new Date(`${date}T00:00:00.000${offset}`);
  if (!Number.isFinite(midnight.getTime())) {
    throw new Error("Invalid Mountain midnight");
  }
  return midnight;
}

export function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || !Number.isInteger(days)) {
    throw new Error("Invalid pet-domain date shift");
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function daysBetweenIsoDates(earlier: string, later: string): number {
  const first = Date.parse(`${earlier}T00:00:00Z`);
  const second = Date.parse(`${later}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    throw new Error("Invalid pet-domain date");
  }
  return Math.round((second - first) / 86_400_000);
}

function required(parts: Map<string, string>, key: string): string {
  const value = parts.get(key);
  if (!value) throw new Error(`Atlas clock omitted ${key}`);
  return value;
}

function normalizeOffset(value: string): string {
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Unsupported Atlas offset ${value}`);
  return `${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}`;
}
