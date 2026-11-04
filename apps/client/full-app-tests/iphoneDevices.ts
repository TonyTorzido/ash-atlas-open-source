/** Device matrix shared by the iPhone layout specs (viewport and simulated safe-area insets, portrait and landscape). */
export interface Insets { t: number; r: number; b: number; l: number }
export interface Device { name: string; w: number; h: number; portrait: Insets; landscape: Insets }
const z = (t = 0, r = 0, b = 0, l = 0): Insets => ({ t, r, b, l });
export const DEVICES: Device[] = [
  { name: "se-375x667", w: 375, h: 667, portrait: z(20), landscape: z() },
  { name: "13mini-375x812", w: 375, h: 812, portrait: z(50, 0, 34), landscape: z(0, 50, 21, 50) },
  { name: "15pro-393x852", w: 393, h: 852, portrait: z(59, 0, 34), landscape: z(0, 59, 21, 59) },
  { name: "15promax-430x932", w: 430, h: 932, portrait: z(59, 0, 34), landscape: z(0, 59, 21, 59) },
  { name: "android-360x740", w: 360, h: 740, portrait: z(24), landscape: z() },
  { name: "pixel8-412x915", w: 412, h: 915, portrait: z(32), landscape: z(0, 0, 0, 32) },
  { name: "android-412x892", w: 412, h: 892, portrait: z(24, 0, 24), landscape: z(0, 0, 24) },
  { name: "ipadmini-744x1133", w: 744, h: 1133, portrait: z(24, 0, 20), landscape: z(24, 0, 20) },
  { name: "plain-390x844", w: 390, h: 844, portrait: z(), landscape: z() },
  { name: "plain-360x780", w: 360, h: 780, portrait: z(), landscape: z() }
];

