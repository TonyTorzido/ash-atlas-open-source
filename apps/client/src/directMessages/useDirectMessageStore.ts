import { useSyncExternalStore } from "react";

import type { DirectMessageStore, DirectMessageStoreSnapshot } from "./directMessageStore.js";

export function useDirectMessageStore(store: DirectMessageStore): DirectMessageStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
