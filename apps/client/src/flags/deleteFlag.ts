import type {
  DroppedItemSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";

export type DeleteFlagResult =
  | {
      ok: true;
      flagId: string;
      inventory: PlayerInventorySnapshot | null;
      droppedItems: DroppedItemSnapshot[];
    }
  | { ok: false; message: string };

export async function deleteFlag(
  serverHttpBase: string,
  flagId: string,
  csrfToken: string
): Promise<DeleteFlagResult> {
  try {
    const url = new URL(`/api/flags/${flagId}`, serverHttpBase);
    const response = await fetch(url, {
      method: "DELETE",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify({ requestId: crypto.randomUUID() })
    });
    const payload = await readResponsePayload(response);
    if (!payload) {
      return {
        ok: false,
        message: response.ok
          ? "delete failed: invalid server response"
          : `delete failed: HTTP ${response.status}`
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message:
          typeof payload.error?.message === "string"
            ? payload.error.message
            : `delete failed: HTTP ${response.status}`
      };
    }
    return {
      ok: true,
      flagId: typeof payload.flagId === "string" ? payload.flagId : flagId,
      inventory: isInventorySnapshot(payload.inventory)
        ? payload.inventory
        : null,
      droppedItems: Array.isArray(payload.droppedItems)
        ? payload.droppedItems as DroppedItemSnapshot[]
        : []
    };
  } catch {
    return {
      ok: false,
      message: "delete failed: network error"
    };
  }
}

async function readResponsePayload(response: Response): Promise<{
  flagId?: unknown;
  inventory?: unknown;
  droppedItems?: unknown;
  error?: { message?: unknown };
} | null> {
  try {
    return (await response.json()) as {
      flagId?: unknown;
      inventory?: unknown;
      droppedItems?: unknown;
      error?: { message?: unknown };
    };
  } catch {
    return null;
  }
}

function isInventorySnapshot(value: unknown): value is PlayerInventorySnapshot {
  return Boolean(
    value &&
    typeof value === "object" &&
    "playerId" in value &&
    "stacks" in value
  );
}
