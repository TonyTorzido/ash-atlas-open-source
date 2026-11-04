# Client domain ownership

`GameClient` remains the public compatibility facade. Core owns transport, generations,
serialization/raw send, parse/validation, negotiation, ping/reconnect, intentional disconnect, and
send outcomes. Domain clients receive only a typed command port, UUID source, and narrow trace
ports. No domain imports React, App, transport, parser, timers, or another domain; no domain queues
or replays mutations.

## Every public method

Names, parameters/defaults, request IDs, payloads, optional keys, trace timing, return types, and
null/false behavior are frozen by this inventory.

| Line | Public method | Return type | Domain | Physical owner |
| --- | --- | --- | --- | --- |
| 95 | `connect` | `void` | session/network/startup | `sessionClient` |
| 293 | `disconnect` | `void` | session/network/startup | `sessionClient` |
| 299 | `recoverIfNeeded` | `"healthy" \| "reconnecting" \| "stopped"` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 393 | `moveTo` | `string \| null` | travel | `travelClient` |
| 418 | `jumpToManor` | `string \| null` | manor | `manorClient` |
| 423 | `enterManor` | `string \| null` | manor | `manorClient` |
| 428 | `cancelManorEntry` | `boolean` | manor | `manorClient` |
| 432 | `requestManorGuests` | `boolean` | manor | `manorClient` |
| 436 | `kickManorGuest` | `boolean` | manor | `manorClient` |
| 440 | `banManorGuest` | `boolean` | manor | `manorClient` |
| 444 | `unbanManorGuest` | `boolean` | manor | `manorClient` |
| 448 | `buildManor` | `string \| null` | manor | `manorClient` |
| 453 | `destroyManor` | `string \| null` | manor | `manorClient` |
| 458 | `exitManor` | `string \| null` | manor | `manorClient` |
| 463 | `manorMoveTo` | `string \| null` | manor | `manorClient` |
| 468 | `openManorStorage` | `string \| null` | manor | `manorClient` |
| 473 | `depositManorItem` | `string \| null` | manor | `manorClient` |
| 478 | `withdrawManorItem` | `string \| null` | manor | `manorClient` |
| 483 | `placeFlag` | `string \| null` | flags | `flagClient` |
| 504 | `cancelFlagBuild` | `boolean` | flags | `flagClient` |
| 508 | `reinforceFlag` | `boolean` | flags | `flagClient` |
| 512 | `devTeleport` | `string \| null` | developer/diagnostics | `developerClient` |
| 517 | `devVisitMine` | `string \| null` | developer/diagnostics | `developerClient` |
| 522 | `visitFlag` | `string \| null` | travel | `travelClient` |
| 537 | `visitWorldMapKingdom` | `string \| null` | travel | `travelClient` |
| 550 | `previewCityFounding` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 554 | `foundCity` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 558 | `requestCityInfo` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 562 | `joinCity` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 566 | `leaveCity` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 570 | `claimCityMayor` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 574 | `relinquishCityMayor` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 578 | `convertCityFlag` | `void` | settlements/cities/Kingdom | `settlementClient` |
| 582 | `visitCity` | `void` | travel | `travelClient` |
| 586 | `visitWorldMapCity` | `void` | travel | `travelClient` |
| 590 | `requestWorldMapDestinations` | `boolean` | world/player/movement/map | `worldGameplayClient` |
| 597 | `requestNearbyCollectibles` | `void` | resources/harvesting/inventory | `harvestingClient` |
| 604 | `surveyArea` | `void` | flags | `flagClient` |
| 612 | `startHarvest` | `void` | resources/harvesting/inventory | `harvestingClient` |
| 620 | `completeHarvest` | `void` | resources/harvesting/inventory | `harvestingClient` |
| 628 | `cancelHarvest` | `void` | resources/harvesting/inventory | `harvestingClient` |
| 636 | `dropItem` | `boolean` | resources/harvesting/inventory | `harvestingClient` |
| 646 | `pickupDroppedItem` | `boolean` | resources/harvesting/inventory | `harvestingClient` |
| 658 | `collectWaterAtCoordinate` | `void` | resources/harvesting/inventory | `harvestingClient` |
| 667 | `requestPetState` | `string \| null` | pets/expeditions | `petClient` |
| 672 | `requestPetMemories` | `string \| null` | pets/expeditions | `petClient` |
| 683 | `adoptPet` | `string \| null` | pets/expeditions | `petClient` |
| 688 | `checkInPet` | `string \| null` | pets/expeditions | `petClient` |
| 693 | `feedPet` | `string \| null` | pets/expeditions | `petClient` |
| 698 | `interactPet` | `string \| null` | pets/expeditions | `petClient` |
| 703 | `viewCompletedPet` | `string \| null` | pets/expeditions | `petClient` |
| 708 | `returnToGrowingPet` | `string \| null` | pets/expeditions | `petClient` |
| 713 | `requestPetDebugState` | `string \| null` | pets/expeditions | `petClient` |
| 718 | `petDebugAction` | `string \| null` | pets/expeditions | `petClient` |
| 735 | `requestPetExpeditionDashboard` | `string \| null` | pets/expeditions | `petClient` |
| 740 | `selectPetExpeditionEcho` | `string \| null` | pets/expeditions | `petClient` |
| 745 | `startPetExpedition` | `string \| null` | pets/expeditions | `petClient` |
| 762 | `acknowledgePetExpedition` | `string \| null` | pets/expeditions | `petClient` |
| 769 | `trainPetExpeditionStat` | `string \| null` | pets/expeditions | `petClient` |
| 776 | `treatPetExpeditionEcho` | `string \| null` | pets/expeditions | `petClient` |
| 783 | `requestPetExpeditionDebugState` | `string \| null` | pets/expeditions | `petClient` |
| 788 | `petExpeditionDebugAction` | `string \| null` | pets/expeditions | `petClient` |
| 804 | `startAttack` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 812 | `spawnMob` | `boolean` | developer/diagnostics | `developerClient` |
| 822 | `clearMobs` | `boolean` | developer/diagnostics | `developerClient` |
| 829 | `requestProgressionSnapshot` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 836 | `requestClassSnapshot` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 840 | `adjustOwnDevProgression` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 849 | `setOwnDevSubclassUnlock` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 858 | `updateClassLoadout` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 874 | `activateSubclass` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 882 | `grantOwnDevelopmentAssets` | `string \| null` | developer/diagnostics | `developerClient` |
| 895 | `activateClass` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 899 | `useNormalAbility` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 913 | `useResetAbility` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 927 | `useUniversalTaunt` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 931 | `createParty` | `boolean` | party | `partyClient` |
| 935 | `invitePartyMember` | `boolean` | party | `partyClient` |
| 943 | `acceptPartyInvite` | `boolean` | party | `partyClient` |
| 951 | `declinePartyInvite` | `boolean` | party | `partyClient` |
| 959 | `sendTravelInvite` | `boolean` | travel | `travelClient` |
| 963 | `respondTravelInvite` | `string \| null` | travel | `travelClient` |
| 980 | `cancelTravelInvite` | `boolean` | travel | `travelClient` |
| 984 | `requestTravelInbox` | `boolean` | travel | `travelClient` |
| 988 | `setPartyTravelAllowed` | `boolean` | party | `partyClient` |
| 992 | `setPartyAutoFollow` | `boolean` | party | `partyClient` |
| 996 | `travelToPartyLeader` | `string \| null` | travel | `travelClient` |
| 1008 | `removePartyMember` | `boolean` | party | `partyClient` |
| 1016 | `leaveParty` | `boolean` | party | `partyClient` |
| 1020 | `changePartyLeader` | `boolean` | party | `partyClient` |
| 1028 | `equipItem` | `string \| null` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1036 | `unequipItem` | `string \| null` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1040 | `upgradeEquipment` | `string \| null` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1053 | `saveCombatKit` | `string \| null` | resources/harvesting/inventory | `harvestingClient` |
| 1066 | `renameCombatKit` | `string \| null` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1079 | `clearCombatKit` | `string \| null` | resources/harvesting/inventory | `harvestingClient` |
| 1092 | `activateCombatKit` | `string \| null` | resources/harvesting/inventory | `harvestingClient` |
| 1105 | `toggleReadiedWeapon` | `string \| null` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1118 | `requestKingdomState` | `boolean` | settlements/cities/Kingdom | `settlementClient` |
| 1125 | `sendKingdomChat` | `boolean` | settlements/cities/Kingdom | `settlementClient` |
| 1133 | `requestWorldResync` | `boolean` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1142 | `selectChatChannel` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1152 | `requestChatBootstrap` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1156 | `sendChatMessage` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1164 | `bootstrapDirectMessages` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1173 | `listDirectMessages` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1184 | `openDirectMessage` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1189 | `requestDirectMessageHistory` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1204 | `sendDirectMessage` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1219 | `updateDirectMessageRead` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1228 | `acknowledgeDirectMessageDelivery` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1237 | `setDirectMessageMute` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1246 | `setDirectMessagePreferences` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1254 | `syncDirectMessages` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1264 | `acknowledgeDirectMessageEvents` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1272 | `requestChatHistory` | `string \| null` | social/chat/DM/inbox | `socialClient` |
| 1289 | `updateChatRead` | `boolean` | social/chat/DM/inbox | `socialClient` |
| 1298 | `marketOpen` | `boolean` | market | `marketClient` |
| 1310 | `marketGetBook` | `boolean` | market | `marketClient` |
| 1319 | `marketRequestQuote` | `boolean` | market | `marketClient` |
| 1334 | `marketCreateOrder` | `boolean` | market | `marketClient` |
| 1353 | `marketSimpleBuy` | `boolean` | market | `marketClient` |
| 1366 | `marketCancelOrder` | `boolean` | market | `marketClient` |
| 1370 | `marketClaim` | `boolean` | market | `marketClient` |
| 1374 | `marketSetSubscriptions` | `boolean` | market | `marketClient` |

## Every ClientMessage discriminant

All 125 discriminants have exactly one planned owner. The implementation registry
must reject duplicates and omissions.

| Owner | Count | Discriminants |
| --- | --- | --- |
| `sessionClient` — session/network/startup | 2 | `HELLO`<br>`PING` |
| `worldGameplayClient` — world/player/movement/map | 3 | `MOVE_TO`<br>`REQUEST_WORLD_MAP_DESTINATIONS`<br>`REQUEST_WORLD_RESYNC` |
| `flagClient` — flags | 4 | `PLACE_FLAG`<br>`CANCEL_FLAG_BUILD`<br>`REINFORCE_FLAG`<br>`SURVEY_AREA` |
| `settlementClient` — settlements/cities/Kingdom | 10 | `PREVIEW_CITY_FOUNDING`<br>`FOUND_CITY`<br>`REQUEST_CITY_INFO`<br>`JOIN_CITY`<br>`LEAVE_CITY`<br>`CLAIM_CITY_MAYOR`<br>`RELINQUISH_CITY_MAYOR`<br>`CONVERT_CITY_FLAG`<br>`REQUEST_KINGDOM_STATE`<br>`KINGDOM_CHAT_SEND` |
| `travelClient` — travel | 9 | `VISIT_FLAG`<br>`VISIT_CITY`<br>`VISIT_WORLD_MAP_CITY`<br>`VISIT_WORLD_MAP_KINGDOM`<br>`SEND_TRAVEL_INVITE`<br>`RESPOND_TRAVEL_INVITE`<br>`CANCEL_TRAVEL_INVITE`<br>`REQUEST_TRAVEL_INBOX`<br>`TRAVEL_TO_PARTY_LEADER` |
| `partyClient` — party | 9 | `CREATE_PARTY`<br>`ADD_PARTY_MEMBER`<br>`REMOVE_PARTY_MEMBER`<br>`LEAVE_PARTY`<br>`CHANGE_PARTY_LEADER`<br>`ACCEPT_PARTY_INVITE`<br>`DECLINE_PARTY_INVITE`<br>`SET_PARTY_TRAVEL_ALLOWED`<br>`SET_PARTY_AUTO_FOLLOW` |
| `manorClient` — manor | 14 | `BUILD_MANOR`<br>`DESTROY_MANOR`<br>`JUMP_TO_MANOR`<br>`ENTER_MANOR`<br>`CANCEL_MANOR_ENTRY`<br>`REQUEST_MANOR_GUESTS`<br>`KICK_MANOR_GUEST`<br>`BAN_MANOR_GUEST`<br>`UNBAN_MANOR_GUEST`<br>`EXIT_MANOR`<br>`MANOR_MOVE_TO`<br>`OPEN_MANOR_STORAGE`<br>`DEPOSIT_MANOR_ITEM`<br>`WITHDRAW_MANOR_ITEM` |
| `harvestingClient` — resources/harvesting/inventory | 7 | `REQUEST_NEARBY_COLLECTIBLES`<br>`START_HARVEST`<br>`COMPLETE_HARVEST`<br>`CANCEL_HARVEST`<br>`PICKUP_DROPPED_ITEM`<br>`COLLECT_WATER_AT_COORDINATE`<br>`DROP_ITEM` |
| `combatEquipmentClient` — combat/equipment/classes/progression | 20 | `START_ATTACK`<br>`CANCEL_ATTACK`<br>`REQUEST_PROGRESSION_SNAPSHOT`<br>`REQUEST_CLASS_SNAPSHOT`<br>`ADJUST_OWN_DEV_PROGRESSION`<br>`SET_OWN_DEV_SUBCLASS_UNLOCK`<br>`UPDATE_CLASS_LOADOUT`<br>`ACTIVATE_SUBCLASS`<br>`ACTIVATE_CLASS`<br>`USE_NORMAL_ABILITY`<br>`USE_RESET_ABILITY`<br>`USE_UNIVERSAL_TAUNT`<br>`EQUIP_ITEM`<br>`UNEQUIP_ITEM`<br>`UPGRADE_EQUIPMENT`<br>`SAVE_COMBAT_KIT`<br>`RENAME_COMBAT_KIT`<br>`CLEAR_COMBAT_KIT`<br>`ACTIVATE_COMBAT_KIT`<br>`TOGGLE_READIED_WEAPON` |
| `socialClient` — social/chat/DM/inbox | 16 | `CHAT_SELECT_CHANNEL`<br>`REQUEST_CHAT_BOOTSTRAP`<br>`CHAT_SEND`<br>`CHAT_HISTORY_REQUEST`<br>`CHAT_READ_UPDATE`<br>`DM_BOOTSTRAP`<br>`DM_LIST`<br>`DM_OPEN`<br>`DM_HISTORY`<br>`DM_SEND`<br>`DM_READ`<br>`DM_DELIVERED`<br>`DM_MUTE`<br>`DM_PREFERENCES`<br>`DM_SYNC`<br>`DM_EVENT_ACK` |
| `marketClient` — market | 8 | `MARKET_OPEN`<br>`MARKET_GET_BOOK`<br>`MARKET_REQUEST_QUOTE`<br>`MARKET_CREATE_ORDER`<br>`MARKET_SIMPLE_BUY`<br>`MARKET_CANCEL_ORDER`<br>`MARKET_CLAIM`<br>`MARKET_SET_SUBSCRIPTIONS` |
| `petClient` — pets/expeditions | 18 | `REQUEST_PET_STATE`<br>`REQUEST_PET_MEMORIES`<br>`ADOPT_PET`<br>`CHECK_IN_PET`<br>`FEED_PET`<br>`INTERACT_PET`<br>`VIEW_COMPLETED_PET`<br>`RETURN_TO_GROWING_PET`<br>`REQUEST_PET_DEBUG_STATE`<br>`PET_DEBUG_ACTION`<br>`REQUEST_PET_EXPEDITION_DASHBOARD`<br>`SELECT_PET_EXPEDITION_ECHO`<br>`START_PET_EXPEDITION`<br>`ACKNOWLEDGE_PET_EXPEDITION`<br>`TRAIN_PET_EXPEDITION_STAT`<br>`TREAT_PET_EXPEDITION_ECHO`<br>`REQUEST_PET_EXPEDITION_DEBUG_STATE`<br>`PET_EXPEDITION_DEBUG_ACTION` |
| `developerClient` — developer/diagnostics | 5 | `DEV_SPAWN_MOB`<br>`DEV_TELEPORT`<br>`DEV_VISIT_MINE`<br>`DEV_CLEAR_MOBS`<br>`GRANT_OWN_DEV_ASSETS` |

## No replay

Movement, flag construction, travel/tolls, market, equipment, class, pet, manor, chat, and DM
mutations remain immediate send attempts only.

## Wave 3B implementation status

All 125 ClientMessage discriminants have one compile-time-checked command owner across core plus
12 domain clients. `GameClient` delegates physical command construction through the narrow typed
command port and keeps all public return types. The exhaustive equivalence matrix contains exactly
122 rows for the 122 public command methods; `connect`, `disconnect`, and `recoverIfNeeded` are the
three public lifecycle methods.

Each row proves exact payload, request-ID generation, optional-field presence, default arguments,
return value, disconnected and terminal behavior, serialization/send containment, and no replay.
No queue or replay was introduced.
