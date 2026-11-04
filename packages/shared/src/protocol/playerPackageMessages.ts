import type {
  PlayerPackageClaimResult,
  PlayerPackageSnapshot
} from "../playerPackages.js";

export type PlayerPackageServerMessage =
  | {
      type: "PLAYER_PACKAGES_SNAPSHOT";
      requestId?: string;
      packages: readonly PlayerPackageSnapshot[];
    }
  | {
      type: "PLAYER_PACKAGE_AVAILABLE";
      package: PlayerPackageSnapshot;
    }
  | ({
      type: "PLAYER_PACKAGE_CLAIM_RESULT";
    } & PlayerPackageClaimResult)
  | {
      type: "PLAYER_PACKAGE_ERROR";
      requestId: string;
      code: string;
      message: string;
      packageId?: string;
      currentPackage?: PlayerPackageSnapshot;
    };

export const PLAYER_PACKAGE_SERVER_MESSAGE_TYPES = new Set<
  PlayerPackageServerMessage["type"]
>([
  "PLAYER_PACKAGES_SNAPSHOT",
  "PLAYER_PACKAGE_AVAILABLE",
  "PLAYER_PACKAGE_CLAIM_RESULT",
  "PLAYER_PACKAGE_ERROR"
]);

export function isPlayerPackageServerMessage(
  message: { type: string }
): message is PlayerPackageServerMessage {
  return PLAYER_PACKAGE_SERVER_MESSAGE_TYPES.has(
    message.type as PlayerPackageServerMessage["type"]
  );
}
