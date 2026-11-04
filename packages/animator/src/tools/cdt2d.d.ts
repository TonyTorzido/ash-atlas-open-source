/*
 * Atlas Animator: original implementation (clean-room, see docs/plans/atlas-animator.md section 2).
 *
 * Types for cdt2d (MIT, constrained Delaunay triangulation), which ships none.
 */
declare module "cdt2d" {
  interface Cdt2dOptions {
    delaunay?: boolean;
    interior?: boolean;
    exterior?: boolean;
    infinity?: boolean;
  }
  function cdt2d(
    points: readonly (readonly [number, number])[],
    edges?: readonly (readonly [number, number])[],
    options?: Cdt2dOptions
  ): [number, number, number][];
  export default cdt2d;
}
