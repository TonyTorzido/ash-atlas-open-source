import type { PlayerSnapshot } from "@ash-atlas/shared";

export type UpdatePlayerColorResult =
  | {
      ok: true;
      player: PlayerSnapshot;
    }
  | {
      ok: false;
      message: string;
    };

export async function updatePlayerColor(
  serverHttpBase: string,
  targetPlayerId: string,
  color: string,
  csrfToken: string
): Promise<UpdatePlayerColorResult> {
  try {
    const response = await fetch(
      `${serverHttpBase}/api/players/${encodeURIComponent(targetPlayerId)}/color`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken
        },
        credentials: "include",
        body: JSON.stringify({ color })
      }
    );
    const body = await readResponsePayload(response);
    if (!body || !response.ok || !body.player) {
      return {
        ok: false,
        message: body?.error?.message ?? "failed to update flag color"
      };
    }
    return {
      ok: true,
      player: body.player
    };
  } catch {
    return {
      ok: false,
      message: "failed to update flag color"
    };
  }
}

async function readResponsePayload(response: Response): Promise<{
  player?: PlayerSnapshot;
  error?: {
    message?: string;
  };
} | null> {
  try {
    return (await response.json()) as {
      player?: PlayerSnapshot;
      error?: {
        message?: string;
      };
    };
  } catch {
    return null;
  }
}
