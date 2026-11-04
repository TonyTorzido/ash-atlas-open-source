export const GOBLIN_DEFENDER_SNARKY_DIALOGUE = Object.freeze([
  "Stinky human. The wind was nicer before you arrived.",
  "Keep your hands where I can see all ten mistakes.",
  "Coin first. Your questions aren't worth credit.",
  "Mind the blades, longshanks. They have standards.",
  "We were here before your map learned to lie.",
  "Tread lightly, softskin. The mud has suffered enough.",
  "Your kind talks too much and says too little.",
  "No bargains after sundown. You look costly enough by daylight.",
  "Watch your purse. It is the cleverest thing about you.",
  "The mud suits you. Finally, a proper tailor.",
  "Steel stays sheathed on goblin ground. Especially yours.",
  "Move along, tall one. You're blocking the useful scenery.",
  "You look lost. It is your most convincing look.",
  "Keep clear of the towers. Their aim improves with ugly targets.",
  "The crows know your name. They sounded disappointed.",
  "Don't stare unless you're buying better manners.",
  "Humans always want directions and never take good advice.",
  "One wrong step, longshanks. Your first was coming here.",
  "Goblin eyes miss nothing. Yours missed the obvious.",
  "Your boots are louder than your thoughts.",
  "Even the rats heard you coming. They filed a complaint.",
  "The market takes gold, not whatever confidence that is.",
  "Best mind your shadow. It looks ready to leave you.",
  "Keep walking, smoothskin. Practice may make it graceful.",
  "The road spits out stranger things, but rarely slower ones.",
  "No heroics in the village. You needn't worry.",
  "A sharp ear keeps its owner alive. Yours look decorative.",
  "The moon favors goblins. It merely tolerates you.",
  "Your armor needs oil. Your swagger needs replacing.",
  "Speak plain. Your clever voice isn't fooling anyone.",
  "The night watch is always watching. Try to be less embarrassing.",
  "You carry trouble like a banner and sense like a thimble.",
  "The ravens follow fools. Hear the wings yet?",
  "Stay out of the dark alleys. They have enough rubbish.",
  "Humans bruise easy. Your pride looks pre-bruised.",
  "You'd fetch little at auction, even polished.",
  "Don't touch what you can't afford. That means most things.",
  "My patience has small teeth and your name on it.",
  "Keep your silver close. Your wits are already missing.",
  "The village remembers thieves and especially clumsy ones.",
  "Your horse has better manners. I asked.",
  "That sword looks borrowed. Competence would too.",
  "Pray your luck holds. Nothing else seems to.",
  "Mind the gutters, longlegs. They may mistake you for kin.",
  "Goblin steel keeps its promises. Can you say the same?"
] as const);

export const GOBLIN_DEFENDER_FUNNY_DIALOGUE = Object.freeze([
  "Ew, a human. Hide ya kids.",
  "Your face could sour fresh milk.",
  "I have seen cleaner boots on a swamp corpse.",
  "Did your barber lose a duel?",
  "You smell like a knight's left boot."
] as const);

export const GOBLIN_DEFENDER_DIALOGUE = Object.freeze([
  ...GOBLIN_DEFENDER_SNARKY_DIALOGUE,
  ...GOBLIN_DEFENDER_FUNNY_DIALOGUE
]);

export function goblinDefenderDialogueForRoll(roll: number): string {
  const boundedRoll = Math.max(0, Math.min(0.9999999999999999, roll));
  return GOBLIN_DEFENDER_DIALOGUE[
    Math.floor(boundedRoll * GOBLIN_DEFENDER_DIALOGUE.length)
  ]!;
}
