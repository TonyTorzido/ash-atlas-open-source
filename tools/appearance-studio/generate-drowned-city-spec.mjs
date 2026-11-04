// Generates tools/appearance-studio/interior-specs/drowned_city.json (geometry from art drop MANIFEST.md).
import fs from "node:fs";

const out = process.argv[2];
const rooms = [];
const doors = [];
const encounters = [];
const triggers = [];

const door = (w, h, side) => ({
  W: { x: 30, y: h / 2 }, E: { x: w - 30, y: h / 2 }, N: { x: w / 2, y: 30 }, S: { x: w / 2, y: h - 30 }
})[side];
const inward = (w, h, side) => ({
  W: { x: 170, y: h / 2 }, E: { x: w - 170, y: h / 2 }, N: { x: w / 2, y: 170 }, S: { x: w / 2, y: h - 170 }
})[side];

function room(id, name, w, h, floor, sides, extra = {}) {
  const anchors = {};
  for (const side of sides) anchors[`door_${side.toLowerCase()}`] = door(w, h, side);
  const r = { id, name, width: w, height: h, floor, anchors, ...extra };
  if (extra.anchors) r.anchors = { ...anchors, ...extra.anchors };
  rooms.push(r);
  return r;
}
const link = (id, from, fromSide, to, toSide, extra = {}) => doors.push({
  id, from: { room: from, anchor: `door_${fromSide.toLowerCase()}` }, to: { room: to, anchor: `door_${toSide.toLowerCase()}` }, ...extra
});
const mobs = (archetype, points) => ({ archetype, at: points.map(([x, y]) => ({ x, y })) });
const fight = (id, roomId, name, groups, extra = {}) => encounters.push({
  id, name, room: roomId, startOn: "room_enter", lockDoors: true, waves: [{ mobs: groups }], ...extra
});

/* ---- entry ---- */
room("dc_sunken_stair", "Sunken Stair", 1000, 1000, "dc_sunken_stair_floor", ["E"], { spawn: { x: 500, y: 820 } });
room("dc_drowned_causeway", "Drowned Causeway", 1600, 800, "dc_drowned_causeway_floor", ["W", "E"]);
room("dc_flooded_plaza", "Flooded Plaza", 1200, 1200, "dc_flooded_plaza_floor", ["W", "N"]);
room("dc_circle_of_tides", "Circle of Tides", 1600, 1600, "dc_circle_of_tides_floor", ["W", "N", "E", "S"], {
  spawn: { x: 800, y: 1350 },
  anchors: { abyssal_gate: { x: 800, y: 800 } },
  zones: [{ id: "tides_safe", purpose: "safe", rect: { x: 0, y: 0, width: 1600, height: 1600 } }],
  objects: [
    { id: "abyssal_gate_art", type: "decoration", prefab: "dc_abyssal_gate", at: { x: 800, y: 800 }, name: "Abyssal Gate", initialState: "closed", layer: "below_player", zIndex: 5 },
    ...["west", "north", "east"].map((side) => ({
      id: `tide_circle_${side}_lit`, type: "decoration", prefab: `dc_circle_segment_${side}`, at: { x: 800, y: 800 },
      name: "Lit Tide Circle", layer: "below_player", zIndex: 2, hidden: true
    }))
  ]
});
link("stair_to_causeway", "dc_sunken_stair", "E", "dc_drowned_causeway", "W", { label: "Wade into the Causeway", reverseLabel: "Back to the Stair" });
link("causeway_to_plaza", "dc_drowned_causeway", "E", "dc_flooded_plaza", "W", { label: "Enter the Plaza", reverseLabel: "Back to the Causeway" });
link("plaza_to_tides", "dc_flooded_plaza", "N", "dc_circle_of_tides", "S", { label: "Climb to the Circle of Tides", reverseLabel: "Back to the Plaza" });
fight("stair_darters", "dc_sunken_stair", "Sunken Stair Darters", [mobs("darter_dc", [[350, 400], [650, 400]])], { lockDoors: false });
fight("causeway_wraiths", "dc_drowned_causeway", "Causeway Ambush", [
  mobs("tide_wraith_dc", [[700, 300], [1100, 500]]), mobs("darter_dc", [[500, 550], [900, 250], [1300, 400]])
]);
fight("plaza_ink", "dc_flooded_plaza", "Flooded Plaza", [
  mobs("ink_pool_dc", [[450, 450], [800, 750]]), mobs("darter_dc", [[700, 400], [400, 800]]), mobs("tide_wraith_dc", [[800, 450]])
]);

/* ---- wings ---- */
const WINGS = [
  {
    key: "obs", label: "Observatory", hubSide: "W", hubDoor: "door_w", entry: "E", exit: "W", rift: { x: 600, y: 230 }, riftReturn: { x: 600, y: 380 },
    segment: "west", boss: { template: "the_watcher", name: "The Watcher", at: { x: 500, y: 700 } },
    bossAnchors: { watcher_dais: { x: 500, y: 700 }, watcher_wave_n: { x: 700, y: 330 }, watcher_wave_s: { x: 700, y: 1070 }, watcher_wave_w: { x: 260, y: 700 } },
    chestAt: { x: 1050, y: 1100 },
    mob: {
      street1: [mobs("drowned_cultist_dc", [[500, 300], [800, 500], [1100, 300]])],
      square: [mobs("void_wisp", [[400, 400], [800, 800]]), mobs("deep_crawler", [[600, 600]]), mobs("drowned_cultist_dc", [[400, 800], [800, 400]])],
      street2: [mobs("deep_crawler", [[500, 400], [1100, 400]]), mobs("void_wisp", [[800, 250], [800, 550]])],
      warden: [mobs("gate_warden_dc", [[600, 600]]), mobs("drowned_cultist_dc", [[450, 750], [750, 750]])],
      lower: [mobs("void_wisp", [[500, 300], [800, 500], [1100, 300]])],
      ante: [mobs("deep_crawler", [[450, 450], [750, 750]]), mobs("drowned_cultist_dc", [[450, 750], [750, 450]])]
    }
  },
  {
    key: "kelp", label: "Kelp Deeps", hubSide: "N", entry: "S", exit: "N", rift: { x: 230, y: 600 }, riftReturn: { x: 380, y: 600 },
    segment: "north", boss: { template: "tidemaw", name: "Tidemaw", at: { x: 676, y: 602 } },
    // Tentacle pools from the floor art (kelp-boss-floor.png, 0.7 units per displayed px).
    bossAnchors: { tidemaw_pool_nw: { x: 301, y: 315 }, tidemaw_pool_ne: { x: 1047, y: 315 }, tidemaw_pool_sw: { x: 301, y: 917 }, tidemaw_pool_se: { x: 1047, y: 917 } },
    chestAt: { x: 1150, y: 1150 },
    mob: {
      street1: [mobs("shellback_dc", [[500, 400], [800, 300], [1100, 400]])],
      square: [mobs("maw_lily", [[400, 400], [800, 400]]), mobs("darter_dc", [[400, 800], [600, 600], [800, 800]])],
      street2: [mobs("coral_golem_dc", [[800, 400]]), mobs("shellback_dc", [[500, 400], [1100, 400]])],
      warden: [mobs("gate_warden_dc", [[600, 600]]), mobs("maw_lily", [[750, 400], [750, 800]])],
      lower: [mobs("darter_dc", [[400, 300], [700, 500], [1000, 300], [1300, 500]])],
      ante: [mobs("coral_golem_dc", [[450, 600], [750, 600]])]
    }
  },
  {
    key: "harbor", label: "Harbor", hubSide: "E", entry: "W", exit: "E", rift: { x: 600, y: 970 }, riftReturn: { x: 600, y: 820 },
    segment: "east", boss: { template: "drowned_admiral", name: "The Drowned Admiral", at: { x: 800, y: 700 } },
    bossAnchors: {},
    chestAt: { x: 1150, y: 1150 },
    mob: {
      street1: [mobs("drowned_deckhand_dc", [[500, 300], [800, 500], [1100, 300]])],
      square: [mobs("phantom_lookout_dc", [[400, 400], [800, 800]]), mobs("drowned_deckhand_dc", [[800, 400], [400, 800]])],
      street2: [mobs("merfolk_harpooner_dc", [[500, 400], [1100, 400]]), mobs("phantom_lookout_dc", [[800, 300]])],
      warden: [mobs("gate_warden_dc", [[600, 600]]), mobs("drowned_deckhand_dc", [[450, 450], [750, 450]])],
      lower: [mobs("merfolk_harpooner_dc", [[500, 300], [800, 500], [1100, 300]])],
      ante: [mobs("phantom_lookout_dc", [[450, 450], [750, 750]]), mobs("merfolk_harpooner_dc", [[600, 600]])]
    }
  }
];

const hubSideToWingEntry = { W: "E", N: "S", E: "W" };
for (const wing of WINGS) {
  const k = wing.key;
  const id = (name) => `dc_${k}_${name}`;
  const ns = wing.entry === "S";
  const street = (name, label) => room(id(name), label, 1600, 800, `dc_${k}_street_floor`, [wing.entry, wing.exit]);
  const square = (name, label, extra) => room(id(name), label, 1200, 1200, `dc_${k}_square_floor`, [wing.entry, wing.exit], extra);
  street("street_1", `${wing.label} Street`);
  square("square", `${wing.label} Square`);
  street("street_2", `${wing.label} Back Street`);
  room(id("warden_hall"), `${wing.label} Warden Hall`, 1200, 1200, `dc_${k}_warden_hall_floor`, [wing.entry, wing.exit], {
    anchors: { rift: wing.rift, rift_return: wing.riftReturn },
    objects: [
      { id: `${k}_time_rift`, type: "decoration", prefab: "dc_time_rift", at: wing.rift, name: "Time Rift", initialState: "closed", layer: "below_player", zIndex: 5 },
      { id: `${k}_floodgate`, type: "decoration", prefab: "dc_floodgate", at: door(1200, 1200, wing.exit === "W" ? "W" : wing.exit === "E" ? "E" : "N"), name: "Floodgate", initialState: "closed", layer: "below_player", zIndex: 5 }
    ]
  });
  // Past rooms share the W/E past floors; the rift lands near the west end.
  room(id("past_street"), "The City Before", 1600, 800, "dc_past_street_floor", ["W", "E"], {
    spawn: { x: 300, y: 400 },
    anchors: { rift_arrival: { x: 300, y: 400 } },
    objects: [
      { id: `${k}_switch_1`, type: "switch", prefab: "dc_tide_switch", at: { x: 1000, y: 230 }, name: "Tide Switch", initialState: "off", interactionLabel: "Turn the Tide Switch" },
      { id: `${k}_citizen_1`, type: "npc", prefab: "dc_drowned_citizen", at: { x: 600, y: 600 }, name: "Citizen" },
      { id: `${k}_citizen_2`, type: "npc", prefab: "dc_drowned_citizen", at: { x: 1250, y: 560 }, name: "Citizen" }
    ]
  });
  room(id("past_square"), "The Square Before", 1200, 1200, "dc_past_square_floor", ["W", "E"], {
    anchors: { return_rift: { x: 900, y: 600 } },
    objects: [
      { id: `${k}_switch_2`, type: "switch", prefab: "dc_tide_switch", at: { x: 600, y: 300 }, name: "Tide Switch", initialState: "off", interactionLabel: "Turn the Tide Switch" },
      { id: `${k}_return_rift_art`, type: "decoration", prefab: "dc_return_rift", at: { x: 900, y: 600 }, name: "Return Rift", layer: "below_player", zIndex: 5 },
      { id: `${k}_citizen_3`, type: "npc", prefab: "dc_drowned_citizen", at: { x: 350, y: 900 }, name: "Citizen" }
    ]
  });
  street("lower_street", `${wing.label} Lower Street`);
  square("antechamber", `${wing.label} Antechamber`);
  const bossSide = wing.entry;
  room(id("boss"), { obs: "The Observatory", kelp: "Tidemaw's Pool", harbor: "The Admiral's Deck" }[k], 1400, 1400, `dc_${k}_boss_floor`, [bossSide], {
    anchors: wing.bossAnchors,
    chests: [{ id: `${k}_chest`, name: "Drowned Hoard", at: wing.chestAt, reward: { gold: 1500, items: [{ itemId: "abyssal_orb", quantity: 2 }] } }]
  });

  const back = "Go back";
  link(`tides_to_${k}`, "dc_circle_of_tides", wing.hubSide, id("street_1"), hubSideToWingEntry[wing.hubSide], { label: `Enter the ${wing.label}`, reverseLabel: "Back to the Circle of Tides" });
  link(`${k}_street_to_square`, id("street_1"), wing.exit, id("square"), wing.entry, { label: "Go on", reverseLabel: back });
  link(`${k}_square_to_street`, id("square"), wing.exit, id("street_2"), wing.entry, { label: "Go on", reverseLabel: back });
  link(`${k}_street_to_hall`, id("street_2"), wing.exit, id("warden_hall"), wing.entry, { label: "Enter the Warden Hall", reverseLabel: back });
  doors.push({
    id: `${k}_rift`, from: { room: id("warden_hall"), anchor: "rift" }, to: { room: id("past_street"), anchor: "rift_arrival" },
    oneWay: true, label: "Step through the Time Rift", presentation: "hatch",
    gates: [{ type: "dungeon_flag", flagId: `${k}_rift_open`, value: true }]
  });
  link(`${k}_past_street_to_square`, id("past_street"), "E", id("past_square"), "W", { label: "Go on", reverseLabel: back });
  doors.push({
    id: `${k}_return_rift`, from: { room: id("past_square"), anchor: "return_rift" }, to: { room: id("warden_hall"), anchor: "rift_return" },
    oneWay: true, label: "Return to the present", presentation: "hatch"
  });
  link(`${k}_floodgate`, id("warden_hall"), wing.exit, id("lower_street"), wing.entry, {
    label: "Through the Floodgate", reverseLabel: "Back to the Warden Hall",
    gates: [{ type: "dungeon_flag", flagId: `${k}_switch_1`, value: true }, { type: "dungeon_flag", flagId: `${k}_switch_2`, value: true }]
  });
  link(`${k}_lower_to_ante`, id("lower_street"), wing.exit, id("antechamber"), wing.entry, { label: "Go on", reverseLabel: back });
  link(`${k}_ante_to_boss`, id("antechamber"), wing.exit, id("boss"), bossSide, { label: "Face what waits", reverseLabel: back });

  fight(`${k}_street_fight`, id("street_1"), `${wing.label} Street`, wing.mob.street1);
  fight(`${k}_square_fight`, id("square"), `${wing.label} Square`, wing.mob.square);
  fight(`${k}_back_street_fight`, id("street_2"), `${wing.label} Back Street`, wing.mob.street2);
  fight(`${k}_warden`, id("warden_hall"), "Gate Warden", wing.mob.warden, {
    onComplete: [
      { setFlag: `${k}_rift_open` },
      { raw: { type: "set_object_state", roomId: id("warden_hall"), objectId: `${k}_time_rift`, state: "open" } },
      { message: "The Gate Warden falls. Its rift tears open onto the city as it was." }
    ]
  });
  fight(`${k}_past_wisps`, id("past_street"), "Chrono Wisps", [mobs("chrono_wisp", [[700, 300], [1000, 500], [1300, 300]])]);
  fight(`${k}_past_square_wisps`, id("past_square"), "Chrono Wisps", [mobs("chrono_wisp", [[500, 500], [700, 700], [500, 800]])]);
  fight(`${k}_lower_fight`, id("lower_street"), `${wing.label} Lower Street`, wing.mob.lower);
  fight(`${k}_ante_fight`, id("antechamber"), `${wing.label} Antechamber`, wing.mob.ante);
  encounters.push({
    id: `${k}_boss`, name: wing.boss.name, room: id("boss"), startOn: "room_enter", lockDoors: true,
    boss: { template: wing.boss.template, name: wing.boss.name, at: wing.boss.at },
    onComplete: [
      { revealChest: `${k}_chest` },
      { setFlag: `${k}_done` },
      { raw: { type: "set_object_available", roomId: "dc_circle_of_tides", objectId: `tide_circle_${wing.segment}_lit`, available: true } },
      { message: `${wing.boss.name} falls. A third of the Circle of Tides lights up.` }
    ]
  });

  // Each past-room switch sets its flag; both together raise the floodgate (either order).
  for (const [n, roomName] of [[1, "past_street"], [2, "past_square"]]) {
    triggers.push({
      id: `${k}_switch_${n}_on`, scope: "instance", repetition: "once",
      event: { type: "object_state", roomId: id(roomName), objectId: `${k}_switch_${n}`, state: "on" },
      actions: [
        { type: "set_dungeon_flag", flagId: `${k}_switch_${n}`, value: true },
        { type: "show_message", text: "Far away, a floodgate groans.", tone: "info" }
      ]
    });
  }
  for (const [flag, other] of [[1, 2], [2, 1]]) {
    triggers.push({
      id: `${k}_floodgate_opens_${flag}`, scope: "instance", repetition: "once",
      event: { type: "dungeon_flag", flagId: `${k}_switch_${flag}`, value: true },
      conditions: { mode: "all", items: [{ type: "dungeon_flag", flagId: `${k}_switch_${other}`, value: true }] },
      actions: [
        { type: "set_object_state", roomId: id("warden_hall"), objectId: `${k}_floodgate`, state: "open" },
        { type: "show_message", text: `The ${wing.label} floodgate rises.`, tone: "success" }
      ]
    });
  }
}

/* ---- the Abyssal Gate and the sanctum ---- */
// Pit, arm platforms and arrival platform from the floor art (abyssal-sanctum-floor.png, 0.8 units per displayed px).
room("dc_abyssal_sanctum", "Abyssal Sanctum", 1600, 1600, "dc_abyssal_sanctum_floor", [], {
  spawn: { x: 772, y: 1400 },
  anchors: { gate_arrival: { x: 772, y: 1400 }, abyssal_cultist_w: { x: 420, y: 732 }, abyssal_cultist_e: { x: 1124, y: 732 } },
  chests: [{ id: "sanctum_chest", name: "Abyssal Hoard", at: { x: 560, y: 1260 }, reward: { gold: 3000, items: [{ itemId: "abyssal_orb", quantity: 4 }] } }],
  shrines: [{ id: "tidecraft_altar", name: "Tidecraft Altar", at: { x: 1000, y: 1300 }, prefab: "dc_tidecraft_altar", skillTurnIn: "tidecraft", interactionLabel: "Present 20 Abyssal Orbs" }],
  objects: [
    ...[["nw", 292, 292], ["ne", 1252, 292], ["sw", 292, 1188], ["se", 1252, 1188]].map(([side, x, y]) => ({
      id: `abyssal_arm_${side}`, type: "destructible", prefab: "dc_abyssal_arm", at: { x, y }, name: "Abyssal Arm",
      initialState: "intact", layer: "below_player", zIndex: 6, interactionLabel: "Plant the tide bomb"
    })),
    ...[[1, 180, 720], [2, 1380, 720], [3, 772, 230], [4, 980, 1400]].map(([n, x, y]) => ({
      id: `tide_bomb_${n}`, type: "decoration", prefab: "dc_tide_bomb", at: { x, y }, name: "Tide Bomb",
      hidden: true, zIndex: 12, interactionLabel: "Pick up the tide bomb"
    }))
  ]
});
const ALL_DONE = ["obs_done", "kelp_done", "harbor_done"];
doors.push({
  id: "tides_to_sanctum", from: { room: "dc_circle_of_tides", anchor: "abyssal_gate" }, to: { room: "dc_abyssal_sanctum", anchor: "gate_arrival" },
  label: "Descend through the Abyssal Gate", reverseLabel: "Climb back to the Circle of Tides", presentation: "hatch",
  gates: ALL_DONE.map((flagId) => ({ type: "dungeon_flag", flagId, value: true }))
});
for (const flag of ALL_DONE) {
  triggers.push({
    id: `abyssal_gate_opens_${flag}`, scope: "instance", repetition: "once",
    event: { type: "dungeon_flag", flagId: flag, value: true },
    conditions: { mode: "all", items: ALL_DONE.filter((other) => other !== flag).map((flagId) => ({ type: "dungeon_flag", flagId, value: true })) },
    actions: [
      { type: "set_object_state", roomId: "dc_circle_of_tides", objectId: "abyssal_gate_art", state: "open" },
      { type: "show_message", text: "The Circle of Tides blazes. The Abyssal Gate opens.", tone: "success" }
    ]
  });
}
encounters.push({
  id: "abyssal_one", name: "The Abyssal One", room: "dc_abyssal_sanctum", startOn: "room_enter", lockDoors: true,
  boss: { template: "abyssal_one", name: "The Abyssal One", at: { x: 772, y: 732 } },
  onComplete: [
    { revealChest: "sanctum_chest" },
    { revealShrine: "tidecraft_altar" },
    { completeDungeon: true },
    { message: "The Abyssal One sinks into the pit. The Drowned City is still." }
  ]
});

const spec = {
  dungeon: {
    id: "drowned_city",
    name: "The Drowned City",
    description: "A city swallowed by the sea. Fight through three drowned wings, light the Circle of Tides, and descend to the Abyssal One. Level 32, entered afloat; no re-entry.",
    instancePolicy: "party_ephemeral",
    resetPolicy: "when_empty",
    despawnAfterSeconds: 900,
    access: {
      minimumLevel: 32,
      entryCost: [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }],
      lockoutDays: 6,
      requiresAfloat: true,
      noReentry: true
    },
    theme: { id: "drowned", backgroundColor: "#06121a", floorColor: "#1f3a44", wallColor: "#2c4a52", accentColor: "#5fd0d6" }
  },
  entranceRoom: "dc_sunken_stair",
  rooms, doors, encounters, triggers
};
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(`rooms ${rooms.length}, doors ${doors.length}, encounters ${encounters.length}, triggers ${triggers.length}`);
