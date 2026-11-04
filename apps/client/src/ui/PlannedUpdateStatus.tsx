import { ConnectionStatusPill } from "./ConnectionRecoveryScreen.js";

// Passive, nonmodal notice for a planned server restart: the world stays
// visible and interactive while the connection is restored.
export function PlannedUpdateStatus(): React.JSX.Element {
  return <ConnectionStatusPill label="Server updating…" detail="Back in a moment" />;
}
