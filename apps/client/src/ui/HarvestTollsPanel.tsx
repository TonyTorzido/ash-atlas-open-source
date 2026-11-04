import type { HarvestTollType, HarvestTollsSnapshot } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import coalMineArtworkUrl from "../assets/coal-mine.png";
import ironMineArtworkUrl from "../assets/iron-mine.png";
import stoneMineArtworkUrl from "../assets/stone-mine.png";
import sulfurMineArtworkUrl from "../assets/sulfur-mine.png";
import oilWellArtworkUrl from "../assets/structures/OilWell1.png";
import { fetchHarvestTolls, saveHarvestToll } from "../harvestAccess/harvestTolls.js";
import {
  GameAppActionBar,
  GameAppCard,
  GameAppShell,
  GameAppTabs
} from "./GameAppShell.js";

const LABELS: Record<HarvestTollType, string> = {
  stone_mine: "Stone Mine",
  coal_mine: "Coal Mine",
  iron_mine: "Iron Mine",
  sulfur_mine: "Sulfur Mine",
  oil_well: "Oil Well"
};
const FACILITY_ARTWORK: Record<HarvestTollType, string> = {
  stone_mine: stoneMineArtworkUrl,
  coal_mine: coalMineArtworkUrl,
  iron_mine: ironMineArtworkUrl,
  sulfur_mine: sulfurMineArtworkUrl,
  oil_well: oilWellArtworkUrl
};
const MINE_TYPES = ["stone_mine", "coal_mine", "iron_mine", "sulfur_mine"] as const;
type HarvestTollsTab = "mines" | "oil_wells";

export type HarvestTollsPanelProps = Readonly<{
  open: boolean; layout: "phone" | "desktop"; serverHttpBase: string; csrfToken: string;
  onClose(): void;
  embedded?: boolean;
}>;

export function HarvestTollsPanel(props: HarvestTollsPanelProps): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<HarvestTollsSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<HarvestTollsTab>("mines");
  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    setMessage(null);
    fetchHarvestTolls(props.serverHttpBase, controller.signal).then((next) => {
      setSnapshot(next);
      setDrafts(Object.fromEntries(next.settings.map((setting) => [setting.harvestType, setting.tollGold])));
    }).catch((error) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Tolls could not be loaded.");
    });
    return () => controller.abort();
  }, [props.open, props.serverHttpBase]);
  const apply = async (key: string, operation: () => Promise<HarvestTollsSnapshot>, feedback: string): Promise<void> => {
    setBusy(key); setMessage(null);
    try {
      const next = await operation();
      setSnapshot(next);
      setDrafts(Object.fromEntries(next.settings.map((setting) => [setting.harvestType, setting.tollGold])));
      setMessage(feedback);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That setting could not be saved.");
    } finally {
      setBusy(null);
    }
  };
  const visibleTypes: readonly HarvestTollType[] = activeTab === "mines"
    ? MINE_TYPES
    : ["oil_well"];
  if (!props.open) {
    return null;
  }
  const content = <>
    {message ? <p role="status">{message}</p> : null}
    <GameAppTabs
      variant="housed"
      tabs={[{ id: "mines", label: "Mines" }, { id: "oil_wells", label: "Oil Wells" }]}
      activeTab={activeTab}
      ariaLabel="Harvest toll sections"
      onChange={(id) => setActiveTab(id as HarvestTollsTab)}
    />
    {!snapshot ? <p>Loading toll settings…</p> : <>
      <section className="game-app-card-grid" aria-label={`${activeTab === "mines" ? "Mine" : "Oil Well"} toll prices`}>
        {visibleTypes.map((harvestType) => {
          const setting = snapshot.settings.find((candidate) => candidate.harvestType === harvestType);
          if (!setting) return null;
          const label = LABELS[harvestType];
          const draft = drafts[harvestType] ?? setting.tollGold;
          const actionKey = `toll:${harvestType}`;
          return <GameAppCard
            key={harvestType}
            title={label}
            badge="PER HARVEST"
            leading={(
              <img
                className="harvest-tolls-facility-artwork"
                src={FACILITY_ARTWORK[harvestType]}
                alt=""
                aria-hidden="true"
                title={label}
              />
            )}
            status="TYPE-WIDE PRICE"
            description={`Applies to every public ${label} you own.`}
            action={(
              <GameAppActionBar>
                <button
                  type="button"
                  disabled={busy !== null || !/^(0|[1-9][0-9]{0,15})$/.test(draft)}
                  onClick={() => void apply(actionKey, () => saveHarvestToll(props.serverHttpBase, props.csrfToken, {
                    harvestType,
                    tollGold: draft,
                    expectedRevision: setting.revision
                  }), `${label} public price saved.`)}
                >
                  {busy === actionKey ? "Saving…" : "Save Price"}
                </button>
              </GameAppActionBar>
            )}
          >
            <div className="harvest-tolls-price-field">
              <label htmlFor={`harvest-toll-${harvestType}`}>Public price in Gold</label>
              <input
                id={`harvest-toll-${harvestType}`}
                aria-label={`${label} public price in Gold`}
                inputMode="numeric"
                pattern="[0-9]*"
                value={draft}
                onChange={(event) => {
                  const value = event.currentTarget.value.replace(/\D/g, "").slice(0, 16);
                  setDrafts((current) => ({ ...current, [harvestType]: value }));
                }}
              />
            </div>
            <p className="harvest-tolls-card-guidance">Public/private access is changed in person at this structure.</p>
          </GameAppCard>;
        })}
      </section>
    </>}
  </>;
  if (props.embedded) {
    return <div className="harvest-tolls-app harvest-tolls-app-embedded">{content}</div>;
  }
  return <GameAppShell
    open={props.open}
    title="Harvest Tolls"
    subtitle="Set harvest prices; visit tolls belong to Access & Travel."
    closeLabel="Close Harvest Tolls"
    className="harvest-tolls-app"
    layout={props.layout}
    onClose={props.onClose}
  >{content}</GameAppShell>;
}
