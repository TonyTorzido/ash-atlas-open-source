import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_PNG_ASSET_REGISTRY,
  RUNTIME_PNG_CLIENT_ASSET_ROOT,
  runtimePngAssetRegistration,
  runtimePngAssetRegistrationById
} from "./runtimePngAssets.js";

describe("runtime PNG asset registry", () => {
  it("retains every cosmetic pack's shared PNG usage without duplicating the world-map hook", async () => {
    const actual = await import("./territoryStructures.js");
    const catalog = structuredClone(actual.TERRITORY_STRUCTURE_CATALOG);
    catalog.packs.violet = actual.cloneTerritoryFlagPack(catalog, "violet", "Violet", "#b65de3");
    vi.doMock("./territoryStructures.js", () => ({ ...actual, TERRITORY_STRUCTURE_CATALOG: catalog }));
    vi.resetModules();
    try {
      const registry = await import("./runtimePngAssets.js");
      const cloth = registry.runtimePngAssetRegistration(`${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/default-cloth.png`);
      expect(cloth?.usages).toHaveLength(2);
      expect(cloth?.usages.map((usage) => usage.label)).toEqual(expect.arrayContaining([
        expect.stringContaining("Stock"), expect.stringContaining("Violet")
      ]));
      const shrine = registry.runtimePngAssetRegistration(`${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/atlas-shrine.png`);
      expect(shrine?.usages.filter((usage) => usage.id === "world-map-atlas-shrine")).toHaveLength(1);
    } finally {
      vi.doUnmock("./territoryStructures.js");
      vi.resetModules();
    }
  });

  it("registers every current production artwork hook at its canonical client path", () => {
    expect(RUNTIME_PNG_ASSET_REGISTRY.map(({ relativeFile }) => relativeFile)).toEqual([
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/GivingBerry2.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-seedling.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-middle-2.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-fruiting.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-mature.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/atlas-shrine.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/bastion-hardware.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/bastion-cloth.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/default-hardware.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/default-cloth.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/tower-hardware.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}flags/tower-cloth.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/infantry.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/archer.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/field-ballista-crew.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-packed.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-deployed.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-launch.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-rock.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber-idle.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber-planting.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber-escaping.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber-detonation.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/war-camp.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/fusion-count-badge.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/barracks.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/armory.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/demolition-factory.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/siege-workshop.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/powder-works.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/loom.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/healer.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/reflection.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/gloom.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/berserker.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/hunter.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/fortified.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/manor-floor.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-floor.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-pot.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-water-tank.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-overlays/overlay-01.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-overlays/overlay-02.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-overlays/overlay-03.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/greenhouse-overlays/overlay-04.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/wheat-seedling.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/wheat-middle-2.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/wheat-middle-3.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/wheat-full.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wheat-seed.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wheat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/gardening-bucket.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/water-bucket.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/haunted/lobby.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/haunted/hall.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/haunted/room.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/haunted/room-left.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/haunted/lower.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/haunted/exterior.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/timber/lobby.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/timber/hall.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/timber/room.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/timber/room-left.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/timber/lower.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/timber/exterior.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/samurai/lobby.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/samurai/hall.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/samurai/room.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/samurai/room-left.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/samurai/lower.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}manors/samurai/exterior.png`,
      "apps/client/public/assets/dungeons/cistern_warrens/sewer-floor.png",
      "apps/client/public/assets/dungeons/cistern_warrens/sewer-door.png",
      "apps/client/public/assets/dungeons/cistern_warrens/exit-ladder.png",
      "apps/client/public/assets/dungeons/shared/chest-closed.png",
      "apps/client/public/assets/dungeons/shared/vault-chest-closed.png",
      "apps/client/public/assets/dungeons/shared/lever-off.png",
      "apps/client/public/assets/dungeons/shared/pressure-plate-released.png",
      "apps/client/public/assets/dungeons/cistern_warrens/hatch-landing-floor.png",
      "apps/client/public/assets/dungeons/cistern_warrens/overflow-channel-floor.png",
      "apps/client/public/assets/dungeons/cistern_warrens/turtle-cistern-floor.png",
      "apps/client/public/assets/dungeons/cistern_warrens/warden-junction-floor.png",
      "apps/client/public/assets/dungeons/cistern_warrens/webbed-tunnels-floor.png",
      "apps/client/public/assets/dungeons/cistern_warrens/brood-chamber-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/cave-mouth-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/the-fork-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/raptor-den-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/mushroom-grotto-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/narrow-pass-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/bone-pit-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/chieftain-throne-floor.png",
      "apps/client/public/assets/dungeons/fangrock_cavern/scale-shrine.png",
      "apps/client/public/assets/dungeons/the_eyrie/cliff-base-floor.png",
      "apps/client/public/assets/dungeons/the_eyrie/switchback-ledge-floor.png",
      "apps/client/public/assets/dungeons/the_eyrie/scrap-hollow-floor.png",
      "apps/client/public/assets/dungeons/the_eyrie/wind-bridge-floor.png",
      "apps/client/public/assets/dungeons/the_eyrie/nest-crown-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/grove-gate-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/blighted-path-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/hermit-clearing-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/fern-hollow-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/treant-ring-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/heartwood-floor.png",
      "apps/client/public/assets/dungeons/blightwood_grove/healing-spring.png",
      "apps/client/public/assets/dungeons/the_eyrie/giant-egg.png",
      "apps/client/public/assets/dungeons/blightwood_grove/grove-hermit.png",
      "apps/client/public/assets/dungeons/drowned_city/sunken-stair-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/drowned-causeway-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/flooded-plaza-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/circle-of-tides-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/obs-street-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/obs-square-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/obs-warden-hall-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/obs-boss-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/kelp-street-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/kelp-square-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/kelp-warden-hall-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/kelp-boss-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/harbor-street-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/harbor-square-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/harbor-warden-hall-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/harbor-boss-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/past-street-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/past-square-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/abyssal-sanctum-floor.png",
      "apps/client/public/assets/dungeons/drowned_city/floodgate-closed.png",
      "apps/client/public/assets/dungeons/drowned_city/time-rift-dormant.png",
      "apps/client/public/assets/dungeons/drowned_city/return-rift.png",
      "apps/client/public/assets/dungeons/drowned_city/tide-switch-off.png",
      "apps/client/public/assets/dungeons/drowned_city/abyssal-gate-sealed.png",
      "apps/client/public/assets/dungeons/drowned_city/tidecraft-altar.png",
      "apps/client/public/assets/dungeons/drowned_city/tide-bomb.png",
      "apps/client/public/assets/dungeons/drowned_city/abyssal-arm-intact.png",
      "apps/client/public/assets/dungeons/drowned_city/drowned-citizen.png",
      "apps/client/public/assets/dungeons/drowned_city/circle-segment-west-lit.png",
      "apps/client/public/assets/dungeons/drowned_city/circle-segment-north-lit.png",
      "apps/client/public/assets/dungeons/drowned_city/circle-segment-east-lit.png",
      "apps/client/public/assets/dungeons/golem_forge/crucible-hub-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/forge-gate-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/slag-yard-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/slag-vault-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/bellows-hall-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/cutting-floor-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/sentinel-walk-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/monolith-gallery-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/bull-pen-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/coil-works-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/gem-vault-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/husk-foundry-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/containment-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/anvil-stair-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/cooling-hall-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/great-forge-floor.png",
      "apps/client/public/assets/dungeons/golem_forge/spark-forge.png",
      "apps/client/public/assets/dungeons/golem_forge/healer-monolith.png",
      "apps/client/public/assets/dungeons/golem_forge/cracked-wall.png",
      "apps/client/public/assets/dungeons/golem_forge/great-anvil-lit.png",
      "apps/client/public/assets/dungeons/golem_forge/wing-sigil-lit.png",
      "apps/client/public/assets/dungeons/golem_forge/forge-door-sealed.png",
      "apps/client/public/assets/dungeons/golem_forge/forge-door-open.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/mountain-gate-floor.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/training-courtyard-floor.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/bell-hall-floor.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/still-garden-floor.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/statue-hall-floor.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/grandmaster-sanctum-floor.png",
      "apps/client/public/assets/dungeons/still_hand_monastery/zephyr-altar.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/lair-mouth-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/ember-tunnels-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/salamander-pools-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/bone-bridge-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/hatchery-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/hoard-vault-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/hoard-chamber-floor.png",
      "apps/client/public/assets/dungeons/wyrm_hollow/wyrm-nest.png",
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/slag.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeon/slime.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeon/slime_miniboss.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}sewer-rat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}sick-sewer-rat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}sewer-rat-miniboss.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/shellback-turtle.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/sewer-spider.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/dune-tick.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/spiderling.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/cave-raptor.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/raptor-runt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/raptor-spitter.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/cave-bat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/raptor-chieftain.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/nest-mouse.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/carrion-chick.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/cliff-hawk.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/thunderwing.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/rot-wolf.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/blighted-stag.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/thornfern.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/blight-treant.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/blight-sprite.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/mimic.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/hollow-elder.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/drakeling.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/magma-salamander.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/lava-slime.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/ash-wyvern.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/drake-broodguard.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/elder-dragon.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/initiate-monk.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/staff-adept.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/shadow-acrobat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/iron-statue.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/bell-spirit.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/ember-shade.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/ashbound-revenant.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/vault-warden.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/sky-scout.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/cloud-sentry.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/cloud-arbiter.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/warden-scout.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/zealot.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/serpent-jailer.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/caged-valkyrie.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/coil-hatchling.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/legion-soldier.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/centurion.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/brood-matron.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/trifang-warden.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/grandmaster.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}mobs/dungeons/brood-matriarch.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}skeleton.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frog-legs.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frost-frog-legs.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/poison-frog-legs.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/desert-toad-legs.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/crab-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ice-crab-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sand-crab-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mangrove-crab-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/small-catch.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jellyfish-jelly.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/crawler-flesh.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/squid-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wolf-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frost-wolf-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dune-wolf-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jungle-wolf-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/bog-wolf-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/deer-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frost-deer-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jungle-deer-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/marsh-deer-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sand-deer-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/hog-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/woolly-hog-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/warthog-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jungle-hog-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mud-hog-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/javelina-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/alligator-tail.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/caiman-tail.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/crocodile-tail.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/bear-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/snow-bear-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/black-bear-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sun-bear-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jungle-tapir-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jaguar-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mandrill-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/capercaillie-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/elk-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/red-squirrel-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/badger-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/grey-squirrel-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/stag-beetle-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/great-grey-owl-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/flying-squirrel-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/plains-bison-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/prairie-dog-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/burrowing-owl-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/giraffe-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/lioness-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/spotted-hyena-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sitatunga-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/emperor-dragonfly-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mountain-ibex-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wild-yak-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/alpine-marmot-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wild-scrub-goat-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/crested-porcupine-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/spur-thighed-tortoise-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dromedary-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fennec-fox-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sidewinder-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/field-hare-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/arctic-hare-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/capybara-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/armadillo-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/red-fox-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wolverine-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ostrich-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/golden-eagle-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/musk-ox-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/seal-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/desert-lion-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/saiga-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/wild-horse-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/steppe-marmot-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/lemming-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/snow-goose-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mammoth-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dire-wolf-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/drake-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dragon-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/grub-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/emperor-penguin-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/peary-caribou-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ice-worm-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sea-otter-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/herring-gull-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/spiny-lobster-tail.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/hammerhead-shark-steak.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/manta-ray-wing.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/humpback-whale-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/muskellunge-fillet.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mute-swan-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/pike-fillet.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/snapping-turtle-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/beaver-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/otter-cut.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/salmon-fillet.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/elemental-ration.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/scorching-bird-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/zappy-bird-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/freezing-bird-meat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/field-ration.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/hearty-ration.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/xoral-essence.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/animal-fat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/antler.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/blubber.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/cached-nuts.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/down-feather.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/feather.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fine-fur.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fish-scale.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/goblin-scrap-charm.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/grave-vine.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/owl-feather.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/poison-gland.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/slime-gel.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ancient-coin.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/barrow-torc.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/beaver-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/beetle-carapace.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/centaur-horsehair.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/claw.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/crude-gem.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/drowned-compass.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/drowned-locket.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dryad-blossom.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dryad-heartwood.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ectoplasm.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fang.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fur-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/grave-cloth.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/hangmans-rope.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/horn.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ibex-horn.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/insect-wing.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/kappa-shell-plate.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/large-egg.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/leech-blood-sac.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mana-shard.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/marauder-sand-veil.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/merfolk-scale.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/merfolk-spearhead.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/nixie-comb.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/otter-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/quill.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/reaper-shard.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/reed-blowdart.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/reptile-scale.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/rimed-draugr-mail.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/rusted-legion-blade.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/scrap-metal.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/sinew.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/small-egg.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/snapper-shell.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/steppe-horsehair-tassel.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/tar-lump.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/tortoise-scute.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/venom-sac.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/yakfolk-wool-bundle.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/bugbear-shag-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/charged-core.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/coral-heartstone.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/cyclops-eye-lens.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/earthen-core.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/harpy-plume.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jaguar-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/kraken-ink.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/lakeglass-tear.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/lion-mane.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/living-heartwood.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/monster-eye.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/pantherfolk-rosette-hide.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/river-essence.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/river-troll-hide.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/riverheart-stone.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/rune-fragment.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/shark-tooth.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/talonbear-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/troll-gristle.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/troll-tooth.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/alder-kings-horn.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/chimera-flame-gland.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/chimera-horn.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/coven-matron-hat.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/crow-crown.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fey-silk.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frogking-crown.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frostborn-jarl-helm.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/gnoll-packlord-mask.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/kraken-beak.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/leech-mother-maw.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mossjaw-warboss-helm.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/serpent-priestess-crown.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/troll-toll-bell.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/centaur-khan-banner.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/elder-serpent-horn.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ember-giant-heart-coal.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/glacier-heart.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/patriarch-tusk.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/stormwing-talon.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/dire-wolf-pelt.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/mammoth-tusk.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/drake-scale.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/drake-tail-spike.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ember-scale.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/fire-gland.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/ember-dragon-horn.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/snapjaw-nectar.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/golem-heartstone.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/RiverBackground.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/LakeBackground.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/OceanBackground.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/lion.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/leaf.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/stag.png`,
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/cross.png`
    ]);
  });

  it("provides editable facility presentation hooks and safe fallbacks", () => {
    const registration = runtimePngAssetRegistration(
      `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/barracks.png`
    );
    expect(registration).toMatchObject({
      label: "Barracks",
      category: "Buildings",
      fallbackKey: "city-foundation",
      usages: [{
        editor: { kind: "world-object", key: "cityStructures.barracks" }
      }]
    });
  });

  it("resolves special military slots by registry id", () => {
    expect(runtimePngAssetRegistrationById("military-fusion_badge")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/fusion-count-badge.png`,
      fallbackKey: "count-badge"
    });
  });

  it("registers independently editable Siege and Bomber state slots", () => {
    expect(runtimePngAssetRegistrationById("military-siege-packed")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-packed.png`,
      label: "Kippen Siege · Mobile / Idle",
      usages: [{ editor: { kind: "sprite", key: "militaryUnits.field_ballista.packed" } }]
    });
    expect(runtimePngAssetRegistrationById("military-siege-deployed")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-deployed.png`,
      label: "Kippen Siege · Deployed / Loading",
      usages: [{ editor: { kind: "sprite", key: "militaryUnits.field_ballista.deployed" } }]
    });
    expect(runtimePngAssetRegistrationById("military-siege-launch")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-launch.png`,
      label: "Kippen Siege · Launch",
      usages: [{ editor: { kind: "sprite", key: "militaryUnits.field_ballista.launch" } }]
    });
    expect(runtimePngAssetRegistrationById("military-siege-rock")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/siege-rock.png`,
      usages: [{ editor: { kind: "sprite", key: "militaryUnits.field_ballista.rock" } }]
    });
    expect(runtimePngAssetRegistrationById("military-bomber-idle")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber-idle.png`,
      usages: [{ editor: { kind: "sprite", key: "militaryUnits.bomber.idle" } }]
    });
    expect(runtimePngAssetRegistrationById("military-bomber-planting")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}military/units/bomber-planting.png`,
      usages: [{ editor: { kind: "sprite", key: "militaryUnits.bomber.planting" } }]
    });
  });

  it("registers the Loom production slot with the Tannery fallback", () => {
    expect(runtimePngAssetRegistrationById("loom")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/loom.png`,
      label: "Loom",
      fallbackKey: "tannery",
      usages: [{
        editor: { kind: "world-object", key: "loom" }
      }]
    });
  });

  it("registers Slag with an independent ground-drop presentation and safe fallback", () => {
    expect(runtimePngAssetRegistrationById("slag")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/slag.png`,
      label: "Slag",
      category: "Items & Equipment",
      fallbackKey: "missing-item-square",
      usages: [
        { editor: { kind: "sprite", key: "slag" } },
        { editor: { kind: "readonly" } }
      ]
    });
  });

  it("registers the approved Manor floor PNG as a Studio-owned building surface", () => {
    expect(runtimePngAssetRegistrationById("manor-floor")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/manor-floor.png`,
      label: "Manor Lobby Floor",
      category: "Buildings",
      fallbackKey: "manor",
      usages: [{ editor: { kind: "readonly" } }]
    });
  });

  it("registers universal food slots with a safe generic fallback", () => {
    expect(runtimePngAssetRegistrationById("item-frog_legs")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/frog-legs.png`,
      label: "Frog Legs",
      category: "Items & Materials",
      fallbackKey: "generic",
      usages: [{
        context: "Inventory, dropped-item prompt, pickup dialog, and Kitchen recipe input share the authored item size",
        editor: { kind: "sprite", key: "food" }
      }]
    });
  });

  it("registers the species-specific food slots with their player-facing labels", () => {
    expect(runtimePngAssetRegistrationById("item-scorching_bird_meat")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/scorching-bird-meat.png`,
      label: "Scorching Bird Meat",
      fallbackKey: "generic"
    });
    expect(runtimePngAssetRegistrationById("item-jellyfish_jelly")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/jellyfish-jelly.png`,
      label: "Jellyfish Jelly",
      fallbackKey: "generic"
    });
  });

  it("registers each fishing background as an independent production slot", () => {
    expect(runtimePngAssetRegistrationById("fishing-background-ocean")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/OceanBackground.png`,
      label: "Ocean Fishing Background",
      category: "Fishing",
      fallbackKey: "generic",
      usages: [{
        id: "production-fishing-ocean-background",
        context: "Overworld fishing encounter scene for the authoritative gameplay water type"
      }]
    });
    expect(runtimePngAssetRegistrationById("fishing-background-river")?.relativeFile)
      .toBe(`${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/RiverBackground.png`);
    expect(runtimePngAssetRegistrationById("fishing-background-lake")?.relativeFile)
      .toBe(`${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/LakeBackground.png`);
  });

  it("registers starter Chat Crest slots with a neutral registered fallback", () => {
    expect(runtimePngAssetRegistrationById("chat-crest-lion")).toMatchObject({
      relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/lion.png`,
      label: "Chat Crest · Lion",
      category: "Chat Crests",
      fallbackKey: "chat-crest-leaf",
      usages: [{ editor: { kind: "readonly" } }]
    });
    expect(runtimePngAssetRegistrationById("chat-crest-leaf")?.relativeFile)
      .toBe(`${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/leaf.png`);
  });
});
