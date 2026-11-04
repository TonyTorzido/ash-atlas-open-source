# Client frame routing

One validated `ServerMessage` enters one exhaustive discriminant registry. The registry uses
`satisfies Record<ServerMessage["type"], ...>` plus runtime cardinality and ownership tests.
There is one primary handler per discriminant; observers run after primary application. No
fallthrough, second parse, second validation, or duplicate dispatch is allowed.

## Every primary owner

| Discriminant | Primary domain | Primary handler |
| --- | --- | --- |
| `MARKET_OPEN_RESULT` | market | `marketClientFrameHandler` |
| `MARKET_BOOK_RESULT` | market | `marketClientFrameHandler` |
| `MARKET_QUOTE_RESULT` | market | `marketClientFrameHandler` |
| `MARKET_MUTATION_RESULT` | market | `marketClientFrameHandler` |
| `MARKET_SUBSCRIPTIONS_SET` | market | `marketClientFrameHandler` |
| `MARKET_ITEM_SUMMARY_CHANGED` | market | `marketClientFrameHandler` |
| `MARKET_BOOK_CHANGED` | market | `marketClientFrameHandler` |
| `MARKET_PLAYER_STATE_CHANGED` | market | `marketClientFrameHandler` |
| `MARKET_ERROR` | market | `marketClientFrameHandler` |
| `DM_BOOTSTRAP_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_LIST_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_OPEN_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_HISTORY_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_SEND_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_READ_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_DELIVERED_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_MUTE_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_PREFERENCES_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_SYNC_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_EVENT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_EVENT_ACKED` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `DM_ERROR` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `PET_STATE` | pets/expeditions | `petClientFrameHandler` |
| `PET_MEMORIES_PAGE` | pets/expeditions | `petClientFrameHandler` |
| `PET_ERROR` | pets/expeditions | `petClientFrameHandler` |
| `PET_DEBUG_STATE` | pets/expeditions | `petClientFrameHandler` |
| `PET_DEBUG_RESULT` | pets/expeditions | `petClientFrameHandler` |
| `PET_EXPEDITION_DASHBOARD` | pets/expeditions | `petClientFrameHandler` |
| `PET_EXPEDITION_DEBUG_STATE` | pets/expeditions | `petClientFrameHandler` |
| `PET_EXPEDITION_DEBUG_RESULT` | pets/expeditions | `petClientFrameHandler` |
| `WORLD_MAP_DESTINATIONS` | world/player/movement/map | `worldGameplayClientFrameHandler` |
| `MANOR_STATUS` | manor | `manorClientFrameHandler` |
| `MANOR_BUILD_RESULT` | manor | `manorClientFrameHandler` |
| `MANOR_DESTROY_RESULT` | manor | `manorClientFrameHandler` |
| `MANORS_SNAPSHOT` | manor | `manorClientFrameHandler` |
| `MANOR_ENTERED` | manor | `manorClientFrameHandler` |
| `MANOR_ENTRY_PENDING` | manor | `manorClientFrameHandler` |
| `MANOR_GUESTS` | manor | `manorClientFrameHandler` |
| `MANOR_EXITED` | manor | `manorClientFrameHandler` |
| `MANOR_POSITION` | manor | `manorClientFrameHandler` |
| `MANOR_STORAGE_SNAPSHOT` | manor | `manorClientFrameHandler` |
| `MANOR_STORAGE_TRANSFER_RESULT` | manor | `manorClientFrameHandler` |
| `MANOR_ERROR` | manor | `manorClientFrameHandler` |
| `KINGDOM_STATE` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `KINGDOM_STATE_CHANGED` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `KINGDOM_SPATIAL_CHANGES` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `KINGDOM_CHAT_MESSAGE` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `SOCIAL_STATE_CHANGED` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_CHANNELS_SNAPSHOT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_UNAVAILABLE` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_CHANNEL_SELECTED` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_SEND_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_MESSAGE` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_HISTORY_RESULT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_PREVIEW_UPDATE` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_READ_STATE` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `CHAT_MUTE_SNAPSHOT` | social/chat/DM/inbox | `socialClientFrameHandler` |
| `SESSION_REPLACED` | session/network/startup | `sessionClientFrameHandler` |
| `AUTH_SESSION_INVALID` | session/network/startup | `sessionClientFrameHandler` |
| `WELCOME` | session/network/startup | `sessionClientFrameHandler` |
| `COMBAT_SNAPSHOT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_DELTA` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_STARTED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_CANCELLED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_REWARD_GRANTED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `DEV_ASSETS_GRANTED` | developer/diagnostics | `developerClientFrameHandler` |
| `DEV_MOB_SPAWNED` | developer/diagnostics | `developerClientFrameHandler` |
| `DEV_MOBS_CLEARED` | developer/diagnostics | `developerClientFrameHandler` |
| `PROGRESSION_SNAPSHOT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `MASTERY_SNAPSHOT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `CLASS_SNAPSHOT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `DEV_PROGRESSION_ADJUSTED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `CLASS_MUTATION_CONFIRMED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `ABILITY_QUEUE_UPDATED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `PARTY_SNAPSHOT` | party | `partyClientFrameHandler` |
| `TRAVEL_INBOX_SNAPSHOT` | travel | `travelClientFrameHandler` |
| `TRAVEL_RESULT` | travel | `travelClientFrameHandler` |
| `CLASS_MASTERY_GRANTED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `XP_GRANTED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `LEVEL_UP` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `EQUIPMENT_SNAPSHOT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `EQUIPMENT_UPDATED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `EQUIPMENT_UPGRADE_RESULT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_KIT_SNAPSHOT` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_KIT_ACTIVATED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `COMBAT_KIT_INVALIDATED` | combat/equipment/classes/progression | `combatEquipmentClientFrameHandler` |
| `PLAYER_SNAPSHOT` | world/player/movement/map | `worldGameplayClientFrameHandler` |
| `PLAYER_DELTA` | world/player/movement/map | `worldGameplayClientFrameHandler` |
| `FLAGS_SNAPSHOT` | flags | `flagClientFrameHandler` |
| `CITIES_SNAPSHOT` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_MEMBERSHIP_SNAPSHOT` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_FOUNDING_PREVIEW` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_INFO` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_FOUNDED` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_JOINED` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_LEFT` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_MEMBERSHIP_UPDATED` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_MAYOR_UPDATED` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_FLAG_CONVERTED` | settlements/cities/Kingdom | `settlementClientFrameHandler` |
| `CITY_VISITED` | travel | `travelClientFrameHandler` |
| `FLAG_BUILD_QUEUED` | flags | `flagClientFrameHandler` |
| `FLAG_BUILD_STARTED` | flags | `flagClientFrameHandler` |
| `FLAG_BUILD_CANCELLED` | flags | `flagClientFrameHandler` |
| `FLAG_CREATED` | flags | `flagClientFrameHandler` |
| `FLAG_UPSERTED` | flags | `flagClientFrameHandler` |
| `FLAG_REINFORCED` | flags | `flagClientFrameHandler` |
| `DEV_TELEPORT_COMPLETED` | developer/diagnostics | `developerClientFrameHandler` |
| `FLAG_DELETED` | flags | `flagClientFrameHandler` |
| `FLAG_UPDATED` | flags | `flagClientFrameHandler` |
| `FLAG_ACCESS_CHANGED` | flags | `flagClientFrameHandler` |
| `FLAG_TOLL_RECEIVED` | travel | `travelClientFrameHandler` |
| `MOVE_ACCEPTED` | world/player/movement/map | `worldGameplayClientFrameHandler` |
| `FLAG_VISITED` | travel | `travelClientFrameHandler` |
| `COLLECTIBLES_SNAPSHOT` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `POPULATION_ZONE_DELTA` | world/player/movement/map | `worldGameplayClientFrameHandler` |
| `RESOURCE_VISION_LOADING` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `RESOURCE_VISION_READY` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `HARVEST_STARTED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `HARVEST_COMPLETED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `HARVEST_CANCELLED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `DEV_MINE_VISIT_COMPLETED` | developer/diagnostics | `developerClientFrameHandler` |
| `REPEATABLE_RESOURCE_HARVESTED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `REPEATABLE_RESOURCE_UPDATED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `RESOURCE_GAINED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `COLLECTIBLE_REMOVED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `COLLECTIBLE_PICKED_UP` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `PLAYER_RESOURCES_UPDATED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `WATER_COLLECTED` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `ITEM_DROP_RESULT` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `DROPPED_ITEM_PICKUP_RESULT` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `DROPPED_ITEMS_SNAPSHOT` | resources/harvesting/inventory | `harvestingClientFrameHandler` |
| `ERROR` | session/network/startup | `sessionClientFrameHandler` |
| `PONG` | session/network/startup | `sessionClientFrameHandler` |

## Important ordering

| Frame | Primary domain | Preserved order |
| --- | --- | --- |
| `WELCOME` | session/network/startup | core compatibility negotiation; startup/session constants; domain bootstrap requests in existing order |
| `PLAYER_SNAPSHOT` | world/player/movement/map | replace sequence/state; snap combat respawns; update local/render refs; notify movement/map/flag observers |
| `PLAYER_DELTA` | world/player/movement/map | sequence gate; apply upserts/removals; movement timeline/local refs; presentation observers |
| `FLAGS_SNAPSHOT` | flags | replace flags; satisfy startup; synchronize Kingdom-seat presentation; publish map snapshot |
| `FLAG_CREATED` | flags | complete build/trace; upsert/select/render; city/resource observers |
| `FLAG_VISITED` | travel | commit relocation/player placement; clear request; flag/resource/map observers |
| `POPULATION_ZONE_DELTA` | world/player/movement/map | revision-fenced projection before collectible/map presentation |
| `COLLECTIBLES_SNAPSHOT` | resources/harvesting/inventory | active resource-vision match; harvest selection; publish map nodes |
| `COMBAT_SNAPSHOT` | combat/equipment/classes/progression | replace store; clock offset; render timeline; combat UI |
| `COMBAT_DELTA` | combat/equipment/classes/progression | sequence/apply; smoothing/life state; UI and invalidation observers |
| `EQUIPMENT_SNAPSHOT` | combat/equipment/classes/progression | authoritative equipment; clear mutation; inventory/progression observers |
| `PARTY_SNAPSHOT` | party | party/invites; display names; travel eligibility |
| `TRAVEL_RESULT` | travel | match request; outcome; authoritative world state finalizes arrival |
| `MANOR_ENTERED` | manor | location/session; world restore; manor runtime; storage/guests |
| `MANOR_EXITED` | manor | clear session/panels; restore world player; map mode |
| `CHAT_CHANNELS_SNAPSHOT` | social/chat/DM/inbox | catalog before selection/history |
| `CHAT_MESSAGE` | social/chat/DM/inbox | deduplicate/store; unread/notification; sender actions |
| `DM_BOOTSTRAP_RESULT` | social/chat/DM/inbox | cursor/conversations/events; recovery; delivery/read acks |
| `DM_SYNC_RESULT` | social/chat/DM/inbox | ordered cursor page; acks; continue only when more |
| `MARKET_* result` | market | MarketController primary; mutation-success collectible observer |
| `AUTH_SESSION_INVALID` | session/network/startup | stop reconnect; invalid session; verify/logout |
| `SESSION_REPLACED` | session/network/startup | replacement semantics; stop reconnect |

Direct-message and market frames enter their typed domain handlers through the same registry.
DM cursor/ack order and market mutation-success observers retain their characterized sequence.
Core-only lifecycle, performance, and trace observations remain explicit pre-route hooks, while
every validated frame has exactly one primary domain route.

## Wave 3B implementation status

The registry compile-time covers all 134 ServerMessage discriminants and dispatches one primary
family followed by observers in registration order. The 132 non-terminal discriminants have one
guarded handler; the two terminal session frames have one explicit fenced route. Direct-message,
market, pet, party, manor, chat, world, settlement, combat/equipment, harvesting, flags, travel,
developer, and session frame bodies are physically domain-owned.

`App.tsx` contains no `ServerMessage` case body or broad frame switch. Architecture fixtures fail
if a broad frame switch, unchecked cast, duplicate owner, missing route, or composition-host frame
implementation returns.
