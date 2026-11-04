import {
  GIFT_MAX_MESSAGE_LENGTH,
  INVENTORY_CATALOG,
  type EquipmentSnapshotV2,
  type PlayerGiftItemLineInput,
  type PlayerGiftStatus,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { requestIdCrypto } from "../requestId.js";
import type { InventoryPanelRow } from "../inventory/inventoryPanelModel.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";
import {
  canAffordGiftBox,
  giftableEquipment,
  giftableInventoryRows,
  giftBoxesCarried,
  giftSendBlockedReason
} from "./giftComposeModel.js";
import { InventoryItemActionDialog } from "./InventoryItemActionDialog.js";
import { ItemArtwork } from "./ItemArtwork.js";

export type GiftFeedback =
  | Readonly<{ kind: "error"; requestId: string; message: string }>
  | Readonly<{ kind: "sent"; requestId: string; recipientName: string }>
  | Readonly<{ kind: "bought"; requestId: string }>;

export type GiftDraft = Readonly<{
  recipientPlayerId: string;
  message?: string;
  items: readonly PlayerGiftItemLineInput[];
  equipmentInstanceIds: readonly string[];
}>;

type Props = Readonly<{
  target: Readonly<{ playerId: string; displayName: string }>;
  status: PlayerGiftStatus | null;
  feedback: GiftFeedback | null;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2 | null;
  walletGold: string | null;
  online: boolean;
  onBuy(requestId: string): boolean;
  onSend(gift: GiftDraft, requestId: string): boolean;
  onClose(): void;
}>;

type Line = { row: InventoryPanelRow; quantity: number };
const PENDING_RETRY_MS = 12_000;

export function GiftComposePanel({
  target, status, feedback, inventory, equipment, walletGold, online, onBuy, onSend, onClose
}: Props): React.JSX.Element {
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [equipmentIds, setEquipmentIds] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("");
  const [picking, setPicking] = useState<InventoryPanelRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sendPending, setSendPending] = useState(false);
  const [buyPending, setBuyPending] = useState(false);
  // A retry of an unanswered send keeps its request id so the server replays it.
  const sendRef = useRef<{ signature: string; id: string } | null>(null);
  const buyIdRef = useRef<string | null>(null);

  const carriedRows = useMemo(() => giftableInventoryRows(inventory), [inventory]);
  const equipmentRows = useMemo(() => giftableEquipment(equipment), [equipment]);
  const rows = carriedRows.flatMap((row) => {
    const remaining = row.quantity - (lines[`${row.itemId}|${row.variant ?? ""}`]?.quantity ?? 0);
    return remaining > 0 ? [{ ...row, quantity: remaining }] : [];
  });
  const boxes = giftBoxesCarried(inventory);
  const lineList = Object.entries(lines);
  const lineCount = lineList.length + equipmentIds.length;
  const blockedReason = giftSendBlockedReason(status, boxes, lineCount);
  const price = status?.giftBoxPriceGold ?? "250";
  const canBuy = online && !buyPending && canAffordGiftBox(walletGold, price);

  useEffect(() => {
    if (!feedback) return;
    if (feedback.kind === "bought") {
      if (feedback.requestId === buyIdRef.current) { buyIdRef.current = null; setBuyPending(false); setError(null); }
      return;
    }
    if (feedback.requestId === buyIdRef.current) {
      buyIdRef.current = null; setBuyPending(false);
      if (feedback.kind === "error") setError(feedback.message);
      return;
    }
    if (feedback.requestId !== sendRef.current?.id) return;
    sendRef.current = null;
    setSendPending(false);
    if (feedback.kind === "error") { setError(feedback.message); return; }
    if (feedback.kind === "sent") setSentTo(feedback.recipientName);
  }, [feedback]);

  useEffect(() => {
    if (sentTo === null) return;
    const timer = window.setTimeout(onClose, 1_600);
    return () => window.clearTimeout(timer);
  }, [onClose, sentTo]);

  useEffect(() => {
    if (!sendPending) return;
    const timer = window.setTimeout(() => setSendPending(false), PENDING_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [sendPending]);

  useEffect(() => {
    if (!buyPending) return;
    const timer = window.setTimeout(() => { buyIdRef.current = null; setBuyPending(false); }, PENDING_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [buyPending]);

  const lineKey = (row: InventoryPanelRow): string => `${row.itemId}|${row.variant ?? ""}`;

  const send = (): void => {
    const items: PlayerGiftItemLineInput[] = lineList.map(([, line]) => ({
      itemKind: INVENTORY_CATALOG[line.row.itemId]?.kind === "consumable" ? "consumable" : "resource",
      itemId: line.row.itemId,
      ...(line.row.variant ? { variant: line.row.variant } : {}),
      quantity: line.quantity
    }));
    const draft: GiftDraft = {
      recipientPlayerId: target.playerId,
      ...(message.trim() ? { message: message.trim() } : {}),
      items,
      equipmentInstanceIds: equipmentIds
    };
    const signature = JSON.stringify(draft);
    if (sendRef.current?.signature !== signature) {
      sendRef.current = { signature, id: requestIdCrypto.randomUUID() };
    }
    setError(null);
    if (!onSend(draft, sendRef.current.id)) {
      setError("You are offline. Reconnect to send this gift.");
      return;
    }
    setSendPending(true);
  };

  const buy = (): void => {
    const id = requestIdCrypto.randomUUID();
    setError(null);
    if (!onBuy(id)) { setError("You are offline. Reconnect to buy a Gift Box."); return; }
    buyIdRef.current = id;
    setBuyPending(true);
  };

  const actions: GamePromptAction[] = sentTo !== null ? [] : [
    {
      key: "buy",
      label: `Buy Gift Box · ${Number(price).toLocaleString()} Gold`,
      tone: "secondary",
      enabled: canBuy,
      busy: buyPending,
      disabledReason: !online ? "Reconnect to buy a Gift Box." : !canAffordGiftBox(walletGold, price) ? "Not enough Gold." : null,
      onSelect: buy
    },
    {
      key: "send",
      label: "Send Gift",
      tone: "primary",
      enabled: online && blockedReason === null && !sendPending,
      busy: sendPending,
      disabledReason: blockedReason || null,
      onSelect: send
    }
  ];

  if (picking) {
    return <InventoryItemActionDialog
      item={picking}
      online
      manorMode={false}
      surfaceLabel="Gift item"
      showInventoryActions={false}
      transferAction={{
        label: "Add to Gift",
        allLabel: "Add All",
        ...(!lines[lineKey(picking)] && lineCount >= (status?.maxLines ?? 8) ? { disabledReason: "A gift is full." } : {}),
        onQuantity: (quantity) => {
          setLines((current) => {
            const key = lineKey(picking);
            return { ...current, [key]: { row: picking, quantity: quantity + (current[key]?.quantity ?? 0) } };
          });
          return true;
        }
      }}
      onClose={() => setPicking(null)}
    />;
  }

  return <GameActionPrompt
    title={`Gift for ${target.displayName}`}
    category={null}
    ariaLabel={`Send a gift to ${target.displayName}`}
    elevated
    detail={sentTo !== null ? null : `${boxes.toLocaleString()} Gift ${boxes === 1 ? "Box" : "Boxes"} owned`}
    message={sentTo !== null
      ? { text: `Gift sent to ${sentTo}.` }
      : error ? { text: error, tone: "error" } : null}
    content={sentTo !== null ? null : <div className="gift-compose">
      {lineCount > 0 ? <ul className="gift-compose-lines" aria-label="Gift contents">
        {lineList.map(([key, line]) => <li key={key}>
          <ItemArtwork itemId={line.row.itemId} variant={line.row.variant} label={line.row.name} />
          <span><strong>{line.row.name}</strong><small>x{line.quantity.toLocaleString()}</small></span>
          <button type="button" className="game-app-button game-app-button-compact" onClick={() => setLines((current) => {
            const next = { ...current }; delete next[key]; return next;
          })}>Remove</button>
        </li>)}
        {equipmentIds.map((id) => {
          const piece = equipmentRows.find((instance) => instance.instanceId === id);
          if (!piece) return null;
          return <li key={id}>
            <ItemArtwork itemId={piece.definitionId} label={piece.displayName} />
            <span><strong>{piece.displayName}</strong><small>x1</small></span>
            <button type="button" className="game-app-button game-app-button-compact"
              onClick={() => setEquipmentIds((current) => current.filter((value) => value !== id))}>Remove</button>
          </li>;
        })}
      </ul> : null}
      <div className="gift-compose-picker">
        {rows.length === 0 && equipmentRows.length === 0
          ? <p className="gift-compose-empty">You have nothing giftable.</p> : null}
        {rows.map((row) => <button type="button" key={lineKey(row)} className="gift-compose-pick"
          onClick={() => setPicking(row)}>
          <ItemArtwork itemId={row.itemId} variant={row.variant} label={row.name} />
          <span><strong>{row.name}</strong><small>x{row.quantity.toLocaleString()}</small></span>
        </button>)}
        {equipmentRows.filter((piece) => !equipmentIds.includes(piece.instanceId)).map((piece) =>
          <button type="button" key={piece.instanceId} className="gift-compose-pick"
            disabled={lineCount >= (status?.maxLines ?? 8)}
            onClick={() => setEquipmentIds((current) => [...current, piece.instanceId])}>
            <ItemArtwork itemId={piece.definitionId} label={piece.displayName} />
            <span><strong>{piece.displayName}</strong><small>Equipment</small></span>
          </button>)}
      </div>
      <textarea className="gift-compose-message" rows={2} maxLength={GIFT_MAX_MESSAGE_LENGTH} value={message}
        placeholder="Add a message (optional)" aria-label="Gift message"
        onChange={(event) => setMessage(event.currentTarget.value)} />
    </div>}
    actions={actions}
    cancelLabel={sentTo !== null ? "Done" : "Cancel"}
    onCancel={onClose}
  />;
}

