import { HEART_PUZZLE_CELL, heartPuzzleForRoom } from "@ash-atlas/shared";

import type { VaultRoomDef } from "./vaultTypes.js";

/** Board layouts live in shared: the server makes the unsolved board's walls solid for players. */
const boardRows = (roomId: string): readonly string[] => heartPuzzleForRoom("tilted_vault", roomId)?.rows ?? [];

/** The Tilted Vault: four rooms, all data. Other Ash Heart dungeons add their own room lists. */
export const TILTED_VAULT_ROOMS: readonly VaultRoomDef[] = [
  {
    id: "vault_r1",
    title: "The Marble Maze",
    intro: "Lean the room and let the marble roll. Mind the holes.",
    win: "reach",
    rows: boardRows("vault_r1"),
    hints: [
      "Easy does it, friend. A marble wants to roll; you only have to ask politely.",
      "Small tilts, early. If you wait until it is at the edge you have already lost it. Tilt back to slow it down.",
      "Along the top, over the middle, down the right side, then left along the long row. The goal is the bottom left corner."
    ],
    lore: [
      "You walk soft. Like she did.",
      "I had a daughter. Wren.",
      "She picked round stones off the canyon floor and called them her marbles.",
      "Kept them in her apron pocket. You could hear her coming. Click, click, click.",
      "I was a stonemason. I could build a wall to stand a hundred years.",
      "But the best thing I ever made was a little wooden maze.",
      "She would tilt it and roll her marbles home, and laugh every time one fell in a hole.",
      "This floor is her maze. I built it again, in stone.",
      "Go on. Roll one home for her."
    ]
  },
  {
    id: "vault_r2",
    title: "Two Weights",
    intro: "A light marble and a heavy one. Both plates must be held at the same time.",
    win: "plates",
    rows: boardRows("vault_r2"),
    hints: [
      "Two stones, two minds. The small one is quick and nimble; the big one barely stirs.",
      "Some doors are narrow. Only the small stone fits through the slit in the middle. The big one waits outside.",
      "Send the small one into the slit chamber and settle it on its plate. Bring the big one down the right side to the plate in the bottom left."
    ],
    lore: [
      "Those shades you passed in the hall. Don't hate them.",
      "They were my neighbours. The baker. The Tolly boys. Old Ansel, who sharpened my chisels.",
      "They didn't reach the door before it sealed.",
      "The Ashen Wars came down the canyon in the night. The whole town burned.",
      "The only way out was the old sealed quarry vault. It only opens for a living heart, given freely.",
      "So I gave it mine. I carved it out and set it in the door.",
      "The floors tilted open. Maren carried Wren through the smoke.",
      "Maren's hand was in mine. Then it was slipping. Then it was gone.",
      "Wren pressed a marble into my palm as they went.",
      "“Roll it home, Papa. We'll come back.”",
      "The vault kept my heart beating in the stone. And it kept me.",
      "So I roll it home. I have been rolling it home ever since."
    ]
  },
  {
    id: "vault_r3",
    title: "The Turning Floor",
    intro: "The floor turns by itself. Cracked tiles hold only one crossing.",
    win: "reach",
    rotationSpeed: 0.11,
    rows: boardRows("vault_r3"),
    hints: [
      "The whole floor is turning, so what is left on your phone is not always left on the stone. Watch the walls, not your hands.",
      "Cracked stone breaks the moment you leave it. Do not turn back. Keep moving, do not stop on a crack.",
      "Right along the top, down the right edge, left along the middle row, down on the left, then right to the goal."
    ],
    lore: [
      "I count the seasons by the ash on the stairs.",
      "I have counted every one. I stopped saying the number out loud. It got too big.",
      "Wren would be grown now. Taller than her mother. Maybe a mother herself.",
      "Maren would be grey. If she is anywhere at all.",
      "They are probably gone. I know that. I am a stonemason. I know how long things last.",
      "The shades still wait by the door, same as me. Some nights I hear them knocking.",
      "I'm sorry they hurt you. They don't know any better anymore. Neither do I, some days.",
      "Every time footsteps come down those stairs, I think it's them.",
      "Every time. Even now."
    ]
  },
  {
    id: "vault_r4",
    title: "The Heart Chamber",
    intro: "A great marble sleeps here. Take a run at the sealed wall.",
    win: "reach",
    rows: boardRows("vault_r4"),
    hints: [
      "That wall is old and tired. It has been waiting for someone to hit it properly.",
      "Weight alone will not do it. You need speed. Roll back from the wall, then lean hard toward it.",
      "Bring the great stone to the bottom row, back off a few paces from the sealed wall, and let it run. A few good hits will do."
    ],
    lore: [
      "This is the last room. My heart is in there, still beating in the stone.",
      "Finish this, and the vault lets go of it. Lets go of me.",
      "And then there is no one here when they come back.",
      "I have been afraid to finish it for a very long time.",
      "…Go on. I'll stand right here. I'll watch."
    ],
    solvedLore: [
      "They're not coming back, are they.",
      "…No.",
      "They lived. That was the point.",
      "That was always the point.",
      "Here. Take it. A heart is meant to be given.",
      "If you ever meet a woman named Wren with a pocket full of stones…",
      "tell her Papa rolled it home."
    ]
  }
];

/** Old Pell's lines. Plain strings so the NPC panel and tests share one source. */
export const OLD_PELL = {
  name: "Old Pell",
  title: "Stonemason's ghost",
  greeting: "Mind the floor, friend. I built it to tilt, and it has not forgiven me since."
} as const;

/** Board cell size in room units, and where each room's board sits. */
export const VAULT_CELL = HEART_PUZZLE_CELL;

export const vaultRoomById = (roomId: string): VaultRoomDef | null =>
  TILTED_VAULT_ROOMS.find((room) => room.id === roomId) ?? null;

/** The authored board origin (the painted room's board zone) when there is one, else the board centred in the room. */
export const vaultBoardOrigin = (
  def: VaultRoomDef,
  roomWidth: number,
  roomHeight: number,
  authored?: Readonly<{ x: number; y: number }> | null
): { x: number; y: number } => authored ? { x: authored.x, y: authored.y } : {
  x: (roomWidth - (def.rows[0]?.length ?? 0) * VAULT_CELL) / 2,
  y: (roomHeight - def.rows.length * VAULT_CELL) / 2
};
