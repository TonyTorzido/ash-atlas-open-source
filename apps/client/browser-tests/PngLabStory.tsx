import { useState, useSyncExternalStore } from "react";

import { DEV_PNG_ASSETS, findDevPngAsset } from "../src/developer/devPngCatalog.js";
import { DevPngLabController } from "../src/developer/devPngLabController.js";
import { calculateDevPngSize } from "../src/developer/devPngSizing.js";
import { DeveloperPngInstanceInspector } from "../src/ui/DeveloperPngInstanceInspector.js";
import { DeveloperPngLab } from "../src/ui/DeveloperPngLab.js";

const ZOOM = 15;

export function PngLabStory(): React.JSX.Element {
  const [controller] = useState(seedController);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [view, setView] = useState<"lab" | "map">("lab");
  return (
    <main className="png-lab-browser-story">
      <style>{`
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        .png-lab-browser-story { position: relative; width: 100%; height: 100%; box-sizing: border-box; container: mobile-app / size; color: #e8e3d8; background: #080b11; overflow: hidden; }
        .png-story-map { position: absolute; inset: 0; overflow: hidden; background: radial-gradient(circle at 30% 40%,#566b43 0 8%,transparent 9%), linear-gradient(25deg,#263824,#526244 48%,#273b2b); }
        .png-story-map::before { content:""; position:absolute; inset:-20%; background: repeating-linear-gradient(110deg,transparent 0 70px,rgba(180,202,142,.09) 72px 75px); transform:rotate(-8deg); }
        .png-story-map-title { position:absolute; z-index:5; top:16px; left:18px; display:grid; gap:3px; padding:10px 13px; border:1px solid rgba(212,173,82,.5); border-radius:9px; background:rgba(16,20,28,.9); }
        .png-story-map-title strong { color:#fde68a; }
        .png-story-placement { position:absolute; z-index:3; padding:0; border:0; background:transparent; cursor:pointer; }
        .png-story-placement img { width:100%; height:100%; object-fit:fill; }
        .png-story-placement.selected { outline:3px solid #fcd34d; outline-offset:4px; }
        .png-story-back { position:absolute; z-index:8; right:16px; top:16px; min-height:40px; padding:8px 12px; color:#e8e3d8; border:1px solid #d4ad52; border-radius:8px; background:#273142; }
        .png-story-lab { width:100%; height:100%; padding:8px; box-sizing:border-box; }
        .png-story-lab .developer-tools-panel { width:100%; height:100%; max-height:none; }
        .png-story-lab .developer-tools-content { min-height:0; }
        @container mobile-app (max-width:640px) { .png-story-lab { padding:0; } .png-story-map-title { max-width:210px; } }
      `}</style>
      {view === "lab" ? (
        <div className="png-story-lab">
          <div className="developer-tools-panel" data-active-tab="png-lab">
            <header><div><span className="eyebrow">Owner only</span><h2>Developer App</h2></div><button type="button" className="modal-close" aria-label="Close Developer App">×</button></header>
            <nav aria-label="Developer tool sections"><button type="button">Admin</button><button type="button">World</button><button type="button" className="active">PNG Lab</button><button type="button">Diagnostics</button></nav>
            <div className="developer-tools-content">
              <DeveloperPngLab
                controller={controller}
                mapZoom={ZOOM}
                playerPosition={{ longitude: -106.6, latitude: 35.1 }}
                onStartPlacement={() => { controller.startPlacement(); setView("map"); }}
                onCenterSelected={() => setView("map")}
              />
            </div>
            <footer><button type="button">Disable all developer views</button><button type="button">Done</button></footer>
          </div>
        </div>
      ) : (
        <section className="png-story-map" aria-label="Local PNG placement map" onClick={(event) => {
          if (!state.placementMode || event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          controller.place(-106.7 + (event.clientX - rect.left) / rect.width * .2, 35.16 - (event.clientY - rect.top) / rect.height * .12);
        }}>
          <div className="png-story-map-title"><strong>PNG Lab placement mode</strong><span>Local-only visual workspace · click open ground for more copies</span></div>
          <button className="png-story-back" type="button" onClick={(event) => { event.stopPropagation(); setView("lab"); }}>Open Full PNG Lab</button>
          {state.placements.map((placement, index) => {
            const asset = findDevPngAsset(placement.assetId);
            if (!asset) return null;
            const size = calculateDevPngSize(asset, state.intrinsicSizes[asset.id] ?? { width: 128, height: 128 }, ZOOM, placement.scaleMultiplier);
            return <button key={placement.id} type="button" className={`png-story-placement${placement.id === state.selectedPlacementId ? " selected" : ""}`} aria-label={`Select ${asset.label} story placement`} style={{ left: `${13 + index * 16}%`, top: `${34 + index % 2 * 25}%`, width: size.width ?? 64, height: size.height ?? 64 }} onClick={(event) => { event.stopPropagation(); controller.selectPlacement(placement.id); }}><img src={asset.url} alt="" /></button>;
          })}
          <DeveloperPngInstanceInspector controller={controller} mapZoom={ZOOM} onCenter={() => undefined} />
        </section>
      )}
    </main>
  );
}

function seedController(): DevPngLabController {
  const controller = new DevPngLabController();
  const samples = [
    ["City Warehouse", "World City Facility", 1],
    ["Tree", "World Resource", 1.2],
    ["Deer", "World Mob", .8],
    ["Wood", "World Ground Drop", 1.5]
  ] as const;
  for (const [label, usage, multiplier] of samples) {
    const asset = DEV_PNG_ASSETS.find((entry) => entry.label === label && entry.usageLabel === usage);
    if (!asset) continue;
    controller.selectAsset(asset.id);
    controller.setNextMultiplier(multiplier);
    controller.place(-106.6, 35.1);
  }
  controller.setNextMultiplier(1);
  controller.selectAsset(DEV_PNG_ASSETS.find(({ label, usageLabel }) => label === "City Warehouse" && usageLabel === "World City Facility")!.id);
  controller.selectPlacement(null);
  return controller;
}
