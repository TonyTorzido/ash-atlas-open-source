import { useSyncExternalStore } from "react";

import type { ChatStore, ChatStoreSnapshot } from "./chatStore.js";

export function useChatStoreSnapshot(store: ChatStore): ChatStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
