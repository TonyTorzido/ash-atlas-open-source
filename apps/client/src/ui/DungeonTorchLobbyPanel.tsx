import { INVENTORY_CATALOG, type DungeonTorchLobbySnapshot } from "@ash-atlas/shared";

import torchIconUrl from "../assets/items/torch.png";
import notReadyIconUrl from "../assets/ui/dungeon/not-ready.png";
import readyIconUrl from "../assets/ui/dungeon/ready-check.png";
import { MaterialChips } from "./MaterialRequirements.js";

export type DungeonTorchLobbyPanelProps = Readonly<{
  lobby: DungeonTorchLobbySnapshot;
  selfPlayerId: string | null;
  /** The player's pack totals, for the per-torch cost chips. */
  have: Readonly<Record<string, number | bigint | undefined>>;
  onSetTorches: (torches: number) => void;
}>;

/**
 * Torch lobby body for a dungeon entrance prompt: the per-torch cost, every member's torch count
 * (a stepper for the viewer's own row) and ready state, and the party total. Ready and Start are
 * the prompt's own actions.
 */
export function DungeonTorchLobbyPanel({ lobby, selfPlayerId, have, onSetTorches }: DungeonTorchLobbyPanelProps): React.JSX.Element {
  const open = lobby.status === "open";
  const room = lobby.maxTotalTorches - lobby.totalTorches;
  return <div className="dungeon-torch-lobby">
    <div className="dungeon-torch-lobby-cost">
      <small>Each torch</small>
      <MaterialChips label="Cost of one torch" materials={lobby.torchCost.map((item) => ({
        itemId: item.itemId, quantity: item.quantity,
        name: INVENTORY_CATALOG[item.itemId as keyof typeof INVENTORY_CATALOG]?.displayName ?? item.itemId,
        have: have[item.itemId] ?? 0
      }))} />
    </div>
    {lobby.members.length > 0 ? <ul className="dungeon-torch-lobby-members" aria-label="Torches by member">
      {lobby.members.map((member) => {
        const self = member.playerId === selfPlayerId;
        const leader = member.playerId === lobby.leaderPlayerId;
        return <li key={member.playerId} data-ready={member.ready ? "true" : "false"} data-self={self ? "true" : "false"}>
          <span className="dungeon-torch-lobby-name">
            {member.name}{leader ? <em> Leader</em> : null}
          </span>
          <span className="dungeon-torch-lobby-count">
            {self && open ? <button type="button" className="dungeon-torch-lobby-step" aria-label="One torch fewer"
              disabled={member.torches <= 0} onClick={() => onSetTorches(member.torches - 1)}>{"−"}</button> : null}
            <img src={torchIconUrl} alt="" aria-hidden="true" />
            <b aria-label={`${member.torches} ${member.torches === 1 ? "torch" : "torches"}`}>{member.torches}</b>
            {self && open ? <button type="button" className="dungeon-torch-lobby-step" aria-label="One torch more"
              disabled={room <= 0} onClick={() => onSetTorches(member.torches + 1)}>+</button> : null}
          </span>
          <span className="dungeon-torch-lobby-ready">
            {lobby.members.length === 1 || (!member.ready && leader) ? null
              : <img src={member.ready ? readyIconUrl : notReadyIconUrl} alt="" aria-hidden="true" />}
            {lobby.members.length === 1 ? "" : member.ready ? "Ready" : leader ? "" : "Not ready"}
          </span>
        </li>;
      })}
    </ul> : null}
    {lobby.status === "in_progress"
      ? <p>Your party's run is under way. Enter to join it; no torches needed.</p>
      : <p className="dungeon-torch-lobby-total">
        Total <b>{lobby.totalTorches}</b> / {lobby.maxTotalTorches} torches
        {lobby.status === "started" ? " · Lit" : lobby.status === "starting" ? " · Lighting…" : ""}
      </p>}
    {lobby.message ? <p className="dungeon-torch-lobby-message" role="alert">{lobby.message}</p> : null}
  </div>;
}
