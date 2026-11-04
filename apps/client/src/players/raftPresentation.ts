/**
 * Water travel: the raft drawn under an afloat player on the overworld map.
 * Sizes are relative to the rendered body so the art can be tuned here
 * without touching render code. The player container's origin is the feet.
 */
export const PLAYER_RAFT_PRESENTATION = Object.freeze({
  assetPath: "apps/client/src/assets/water/raft.png",
  /** Authored canvas of raft.png (tight crop with 16 px padding). */
  canvasWidthPx: 512,
  canvasHeightPx: 313,
  /** Visible body width as a fraction of the rendered body height. */
  bodyWidthToHeight: 0.5,
  /** Raft canvas width as a multiple of the body width. */
  widthToBodyWidth: 2.4,
  /** Raft point placed on the feet: deck centre, nudged up for the 3/4 front edge. */
  anchorX: 0.5,
  anchorY: 0.46,
  /** Gentle bob in screen pixels; 0 under reduced motion. */
  bobAmplitudePx: 1,
  bobPeriodMs: 2800
});
