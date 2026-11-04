import type { FlagSnapshot } from "@ash-atlas/shared";

export type RenameFlagResult =
  | {
      ok: true;
      flag: FlagSnapshot;
    }
  | {
      ok: false;
      message: string;
    };

export async function renameFlag(
  serverHttpBase: string,
  flagId: string,
  name: string,
  csrfToken: string
): Promise<RenameFlagResult> {
  try {
    const response = await fetch(`${serverHttpBase}/api/flags/${flagId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken
      },
      credentials: "include",
      body: JSON.stringify({ name })
    });
    const payload = await readResponsePayload(response);
    if (!payload) {
      return {
        ok: false,
        message: response.ok
          ? "rename failed: invalid server response"
          : `rename failed: HTTP ${response.status}`
      };
    }
    if (!response.ok || !payload.flag) {
      return {
        ok: false,
        message: payload.error?.message ?? `rename failed: HTTP ${response.status}`
      };
    }
    return {
      ok: true,
      flag: payload.flag
    };
  } catch {
    return {
      ok: false,
      message: "rename failed: network error"
    };
  }
}

async function readResponsePayload(response: Response): Promise<{
  flag?: FlagSnapshot;
  error?: { message?: string };
} | null> {
  try {
    return (await response.json()) as {
      flag?: FlagSnapshot;
      error?: { message?: string };
    };
  } catch {
    return null;
  }
}
