import {
  RUNTIME_PNG_CLIENT_ASSET_ROOT,
  chatCrestDefinition,
  type ChatCrestId
} from "@ash-atlas/shared";

import { runtimePngAssetUrl } from "../map/runtimePngAssetUrl.js";

export function chatCrestAssetUrl(id: unknown): string | null {
  const crest = chatCrestDefinition(id);
  return runtimePngAssetUrl(`${RUNTIME_PNG_CLIENT_ASSET_ROOT}${crest.assetKey}`);
}

export function chatCrestLabel(id: unknown): string {
  return chatCrestDefinition(id).label;
}

export function normalizedChatCrestId(id: unknown): ChatCrestId {
  return chatCrestDefinition(id).id;
}
