# Shared protocol ownership

`packages/shared/src/protocol.ts` remains a compatibility path but must become a thin re-export;
`packages/shared/src/index.ts` keeps all accepted exports. Protocol ID/version/min/max, legacy
path, capability metadata, close code 4003, payloads, optional fields, numeric limits, 1 MiB frame
limit, passthrough behavior, and failure classifications do not change.

## Client ownership

| Owner | Count | Discriminants |
| --- | --- | --- |
| `sessionProtocol` — session/network/startup | 2 | `HELLO`<br>`PING` |
| `worldGameplayProtocol` — world/player/movement/map | 3 | `MOVE_TO`<br>`REQUEST_WORLD_MAP_DESTINATIONS`<br>`REQUEST_WORLD_RESYNC` |
| `flagProtocol` — flags | 4 | `PLACE_FLAG`<br>`CANCEL_FLAG_BUILD`<br>`REINFORCE_FLAG`<br>`SURVEY_AREA` |
| `settlementProtocol` — settlements/cities/Kingdom | 10 | `PREVIEW_CITY_FOUNDING`<br>`FOUND_CITY`<br>`REQUEST_CITY_INFO`<br>`JOIN_CITY`<br>`LEAVE_CITY`<br>`CLAIM_CITY_MAYOR`<br>`RELINQUISH_CITY_MAYOR`<br>`CONVERT_CITY_FLAG`<br>`REQUEST_KINGDOM_STATE`<br>`KINGDOM_CHAT_SEND` |
| `travelProtocol` — travel | 9 | `VISIT_FLAG`<br>`VISIT_CITY`<br>`VISIT_WORLD_MAP_CITY`<br>`VISIT_WORLD_MAP_KINGDOM`<br>`SEND_TRAVEL_INVITE`<br>`RESPOND_TRAVEL_INVITE`<br>`CANCEL_TRAVEL_INVITE`<br>`REQUEST_TRAVEL_INBOX`<br>`TRAVEL_TO_PARTY_LEADER` |
| `partyProtocol` — party | 9 | `CREATE_PARTY`<br>`ADD_PARTY_MEMBER`<br>`REMOVE_PARTY_MEMBER`<br>`LEAVE_PARTY`<br>`CHANGE_PARTY_LEADER`<br>`ACCEPT_PARTY_INVITE`<br>`DECLINE_PARTY_INVITE`<br>`SET_PARTY_TRAVEL_ALLOWED`<br>`SET_PARTY_AUTO_FOLLOW` |
| `manorProtocol` — manor | 14 | `BUILD_MANOR`<br>`DESTROY_MANOR`<br>`JUMP_TO_MANOR`<br>`ENTER_MANOR`<br>`CANCEL_MANOR_ENTRY`<br>`REQUEST_MANOR_GUESTS`<br>`KICK_MANOR_GUEST`<br>`BAN_MANOR_GUEST`<br>`UNBAN_MANOR_GUEST`<br>`EXIT_MANOR`<br>`MANOR_MOVE_TO`<br>`OPEN_MANOR_STORAGE`<br>`DEPOSIT_MANOR_ITEM`<br>`WITHDRAW_MANOR_ITEM` |
| `harvestingProtocol` — resources/harvesting/inventory | 7 | `REQUEST_NEARBY_COLLECTIBLES`<br>`START_HARVEST`<br>`COMPLETE_HARVEST`<br>`CANCEL_HARVEST`<br>`PICKUP_DROPPED_ITEM`<br>`COLLECT_WATER_AT_COORDINATE`<br>`DROP_ITEM` |
| `combatEquipmentProtocol` — combat/equipment/classes/progression | 20 | `START_ATTACK`<br>`CANCEL_ATTACK`<br>`REQUEST_PROGRESSION_SNAPSHOT`<br>`REQUEST_CLASS_SNAPSHOT`<br>`ADJUST_OWN_DEV_PROGRESSION`<br>`SET_OWN_DEV_SUBCLASS_UNLOCK`<br>`UPDATE_CLASS_LOADOUT`<br>`ACTIVATE_SUBCLASS`<br>`ACTIVATE_CLASS`<br>`USE_NORMAL_ABILITY`<br>`USE_RESET_ABILITY`<br>`USE_UNIVERSAL_TAUNT`<br>`EQUIP_ITEM`<br>`UNEQUIP_ITEM`<br>`UPGRADE_EQUIPMENT`<br>`SAVE_COMBAT_KIT`<br>`RENAME_COMBAT_KIT`<br>`CLEAR_COMBAT_KIT`<br>`ACTIVATE_COMBAT_KIT`<br>`TOGGLE_READIED_WEAPON` |
| `socialProtocol` — social/chat/DM/inbox | 16 | `CHAT_SELECT_CHANNEL`<br>`REQUEST_CHAT_BOOTSTRAP`<br>`CHAT_SEND`<br>`CHAT_HISTORY_REQUEST`<br>`CHAT_READ_UPDATE`<br>`DM_BOOTSTRAP`<br>`DM_LIST`<br>`DM_OPEN`<br>`DM_HISTORY`<br>`DM_SEND`<br>`DM_READ`<br>`DM_DELIVERED`<br>`DM_MUTE`<br>`DM_PREFERENCES`<br>`DM_SYNC`<br>`DM_EVENT_ACK` |
| `marketProtocol` — market | 8 | `MARKET_OPEN`<br>`MARKET_GET_BOOK`<br>`MARKET_REQUEST_QUOTE`<br>`MARKET_CREATE_ORDER`<br>`MARKET_SIMPLE_BUY`<br>`MARKET_CANCEL_ORDER`<br>`MARKET_CLAIM`<br>`MARKET_SET_SUBSCRIPTIONS` |
| `petProtocol` — pets/expeditions | 18 | `REQUEST_PET_STATE`<br>`REQUEST_PET_MEMORIES`<br>`ADOPT_PET`<br>`CHECK_IN_PET`<br>`FEED_PET`<br>`INTERACT_PET`<br>`VIEW_COMPLETED_PET`<br>`RETURN_TO_GROWING_PET`<br>`REQUEST_PET_DEBUG_STATE`<br>`PET_DEBUG_ACTION`<br>`REQUEST_PET_EXPEDITION_DASHBOARD`<br>`SELECT_PET_EXPEDITION_ECHO`<br>`START_PET_EXPEDITION`<br>`ACKNOWLEDGE_PET_EXPEDITION`<br>`TRAIN_PET_EXPEDITION_STAT`<br>`TREAT_PET_EXPEDITION_ECHO`<br>`REQUEST_PET_EXPEDITION_DEBUG_STATE`<br>`PET_EXPEDITION_DEBUG_ACTION` |
| `developerProtocol` — developer/diagnostics | 5 | `DEV_SPAWN_MOB`<br>`DEV_TELEPORT`<br>`DEV_VISIT_MINE`<br>`DEV_CLEAR_MOBS`<br>`GRANT_OWN_DEV_ASSETS` |

## Server ownership

| Owner | Count | Discriminants |
| --- | --- | --- |
| `sessionProtocol` — session/network/startup | 5 | `SESSION_REPLACED`<br>`AUTH_SESSION_INVALID`<br>`WELCOME`<br>`ERROR`<br>`PONG` |
| `worldGameplayProtocol` — world/player/movement/map | 5 | `WORLD_MAP_DESTINATIONS`<br>`PLAYER_SNAPSHOT`<br>`PLAYER_DELTA`<br>`MOVE_ACCEPTED`<br>`POPULATION_ZONE_DELTA` |
| `flagProtocol` — flags | 10 | `FLAGS_SNAPSHOT`<br>`FLAG_BUILD_QUEUED`<br>`FLAG_BUILD_STARTED`<br>`FLAG_BUILD_CANCELLED`<br>`FLAG_CREATED`<br>`FLAG_UPSERTED`<br>`FLAG_REINFORCED`<br>`FLAG_DELETED`<br>`FLAG_UPDATED`<br>`FLAG_ACCESS_CHANGED` |
| `settlementProtocol` — settlements/cities/Kingdom | 14 | `KINGDOM_STATE`<br>`KINGDOM_STATE_CHANGED`<br>`KINGDOM_SPATIAL_CHANGES`<br>`KINGDOM_CHAT_MESSAGE`<br>`CITY_MEMBERSHIP_SNAPSHOT`<br>`CITY_FOUNDING_PREVIEW`<br>`CITY_INFO`<br>`CITY_FOUNDED`<br>`CITY_JOINED`<br>`CITY_LEFT`<br>`CITY_MEMBERSHIP_UPDATED`<br>`CITY_MAYOR_UPDATED`<br>`CITY_FLAG_CONVERTED`<br>`CITIES_SNAPSHOT` |
| `travelProtocol` — travel | 5 | `TRAVEL_INBOX_SNAPSHOT`<br>`TRAVEL_RESULT`<br>`FLAG_TOLL_RECEIVED`<br>`FLAG_VISITED`<br>`CITY_VISITED` |
| `partyProtocol` — party | 1 | `PARTY_SNAPSHOT` |
| `manorProtocol` — manor | 12 | `MANOR_STATUS`<br>`MANOR_BUILD_RESULT`<br>`MANOR_DESTROY_RESULT`<br>`MANORS_SNAPSHOT`<br>`MANOR_ENTERED`<br>`MANOR_ENTRY_PENDING`<br>`MANOR_GUESTS`<br>`MANOR_EXITED`<br>`MANOR_POSITION`<br>`MANOR_STORAGE_SNAPSHOT`<br>`MANOR_STORAGE_TRANSFER_RESULT`<br>`MANOR_ERROR` |
| `harvestingProtocol` — resources/harvesting/inventory | 16 | `COLLECTIBLES_SNAPSHOT`<br>`RESOURCE_VISION_LOADING`<br>`RESOURCE_VISION_READY`<br>`HARVEST_STARTED`<br>`HARVEST_COMPLETED`<br>`HARVEST_CANCELLED`<br>`REPEATABLE_RESOURCE_HARVESTED`<br>`REPEATABLE_RESOURCE_UPDATED`<br>`RESOURCE_GAINED`<br>`COLLECTIBLE_REMOVED`<br>`COLLECTIBLE_PICKED_UP`<br>`PLAYER_RESOURCES_UPDATED`<br>`WATER_COLLECTED`<br>`ITEM_DROP_RESULT`<br>`DROPPED_ITEM_PICKUP_RESULT`<br>`DROPPED_ITEMS_SNAPSHOT` |
| `combatEquipmentProtocol` — combat/equipment/classes/progression | 20 | `COMBAT_SNAPSHOT`<br>`COMBAT_DELTA`<br>`COMBAT_STARTED`<br>`COMBAT_CANCELLED`<br>`COMBAT_REWARD_GRANTED`<br>`PROGRESSION_SNAPSHOT`<br>`MASTERY_SNAPSHOT`<br>`CLASS_SNAPSHOT`<br>`DEV_PROGRESSION_ADJUSTED`<br>`CLASS_MUTATION_CONFIRMED`<br>`ABILITY_QUEUE_UPDATED`<br>`CLASS_MASTERY_GRANTED`<br>`EQUIPMENT_SNAPSHOT`<br>`EQUIPMENT_UPDATED`<br>`EQUIPMENT_UPGRADE_RESULT`<br>`COMBAT_KIT_SNAPSHOT`<br>`COMBAT_KIT_ACTIVATED`<br>`COMBAT_KIT_INVALIDATED`<br>`XP_GRANTED`<br>`LEVEL_UP` |
| `socialProtocol` — social/chat/DM/inbox | 23 | `DM_BOOTSTRAP_RESULT`<br>`DM_LIST_RESULT`<br>`DM_OPEN_RESULT`<br>`DM_HISTORY_RESULT`<br>`DM_SEND_RESULT`<br>`DM_READ_RESULT`<br>`DM_DELIVERED_RESULT`<br>`DM_MUTE_RESULT`<br>`DM_PREFERENCES_RESULT`<br>`DM_SYNC_RESULT`<br>`DM_EVENT`<br>`DM_EVENT_ACKED`<br>`DM_ERROR`<br>`SOCIAL_STATE_CHANGED`<br>`CHAT_CHANNELS_SNAPSHOT`<br>`CHAT_UNAVAILABLE`<br>`CHAT_CHANNEL_SELECTED`<br>`CHAT_SEND_RESULT`<br>`CHAT_MESSAGE`<br>`CHAT_HISTORY_RESULT`<br>`CHAT_PREVIEW_UPDATE`<br>`CHAT_READ_STATE`<br>`CHAT_MUTE_SNAPSHOT` |
| `marketProtocol` — market | 9 | `MARKET_OPEN_RESULT`<br>`MARKET_BOOK_RESULT`<br>`MARKET_QUOTE_RESULT`<br>`MARKET_MUTATION_RESULT`<br>`MARKET_SUBSCRIPTIONS_SET`<br>`MARKET_ITEM_SUMMARY_CHANGED`<br>`MARKET_BOOK_CHANGED`<br>`MARKET_PLAYER_STATE_CHANGED`<br>`MARKET_ERROR` |
| `petProtocol` — pets/expeditions | 8 | `PET_STATE`<br>`PET_MEMORIES_PAGE`<br>`PET_ERROR`<br>`PET_DEBUG_STATE`<br>`PET_DEBUG_RESULT`<br>`PET_EXPEDITION_DASHBOARD`<br>`PET_EXPEDITION_DEBUG_STATE`<br>`PET_EXPEDITION_DEBUG_RESULT` |
| `developerProtocol` — developer/diagnostics | 5 | `DEV_ASSETS_GRANTED`<br>`DEV_MOBS_CLEARED`<br>`DEV_MOB_SPAWNED`<br>`DEV_TELEPORT_COMPLETED`<br>`DEV_MINE_VISIT_COMPLETED` |

Domain fragments assemble through `clientMessages.ts`, `serverMessages.ts`,
`serverMessageValidation.ts`, `serverMessageFixtures.ts`, and one `ownership.ts` registry.
Tests must prove 125 client owners and 134 server owners, schemas, and
fixtures with no missing or duplicate key. Raw parsing and validation remain single-route.

The two accepted cycles are removed through neutral leaves: shared class/combat/progression
identifiers below all three modules, and equipment balance primitives below both equipment files.
No barrel may hide a back-edge; final architecture requires zero cycles.

## Wave 3B implementation status

All 134 ServerMessage TypeScript discriminants have one physical type owner, all 125 ClientMessage
runtime schemas have one physical schema owner, all 134 server validation routes and fixtures are
exhaustive, compatibility exports compile, and the architecture graph has zero cycles.

Runtime schema bodies, validation ownership, fixture ownership, and aggregate construction are
physically located in domain modules. `protocol.ts` is a 33-line compatibility boundary containing
only narrow imports and re-exports. Architecture fixtures reject schema/union/registry bodies in
that host or a replacement protocol monolith.
