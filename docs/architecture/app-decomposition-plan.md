# App decomposition plan

`App.tsx` will become a composition root, not be copied into a replacement monolith. Extraction
order is command domains, exhaustive frame router, domain state/controllers, map runtime, feature
views, then thin composition. Primary handlers update synchronously; named observers run in the
same source order.

## State and reducer inventory

| Line | Hook binding | Primary owner | Secondary observers |
| --- | --- | --- | --- |
| 369 | `[releaseStatus, setReleaseStatus]` | session/network/startup | none |
| 414 | `[seconds, setSeconds]` | application composition | none |
| 507 | `[connectionStatus, setConnectionStatus]` | session/network/startup | none |
| 508 | `[startup, dispatchStartup]` | session/network/startup | none |
| 511 | `[phoneHudDiagnostics, setPhoneHudDiagnostics]` | developer/diagnostics | none |
| 518 | `[players, setPlayers]` | world/player/movement/map | none |
| 519 | `[flags, setFlags]` | flags | none |
| 520 | `[flagAccessRevision, setFlagAccessRevision]` | flags | none |
| 521 | `[cities, setCities]` | settlements/cities/Kingdom | none |
| 522 | `[cityMembership, setCityMembership]` | settlements/cities/Kingdom | none |
| 523 | `[cityInfo, setCityInfo]` | settlements/cities/Kingdom | none |
| 524 | `[cityFoundingPreview, setCityFoundingPreview]` | settlements/cities/Kingdom | none |
| 525 | `[manors, setManors]` | manor | world/player/movement/map |
| 526 | `[ownManor, setOwnManor]` | manor | world/player/movement/map |
| 527 | `[collectibles, setCollectibles]` | resources/harvesting/inventory | none |
| 528 | `[droppedItems, setDroppedItems]` | application composition | none |
| 529 | `[resourceVision, setResourceVision]` | resources/harvesting/inventory | none |
| 530 | `[resourceVisionStatus, setResourceVisionStatus]` | resources/harvesting/inventory | none |
| 533 | `[populationPreparing, setPopulationPreparing]` | application composition | none |
| 534 | `[waterHighlights, setWaterHighlights]` | resources/harvesting/inventory | none |
| 536 | `[flagPlacementTerrain, setFlagPlacementTerrain]` | flags | none |
| 538 | `[flagPlacementValidation, setFlagPlacementValidation]` | flags | none |
| 539 | `[inventory, setInventory]` | resources/harvesting/inventory | world/player/movement/map |
| 542 | `[locationMode, setLocationMode]` | world/player/movement/map | none |
| 543 | `[manorPanelOpen, setManorPanelOpen]` | manor | none |
| 544 | `[manorBuildPanelOpen, setManorBuildPanelOpen]` | manor | none |
| 545 | `[manorSession, setManorSession]` | manor | session/network/startup |
| 546 | `[manorStorage, setManorStorage]` | manor | none |
| 547 | `[manorStorageOpen, setManorStorageOpen]` | manor | none |
| 548 | `[manorGuests, setManorGuests]` | manor | none |
| 549 | `[manorGuestPanelOpen, setManorGuestPanelOpen]` | manor | none |
| 550 | `[manorFeedback, setManorFeedback]` | manor | none |
| 551 | `[manorTransferFlash, setManorTransferFlash]` | manor | none |
| 552 | `[selectedFlagId, setSelectedFlagId]` | flags | none |
| 553 | `[selectedCityId, setSelectedCityId]` | settlements/cities/Kingdom | none |
| 554 | `[selectedManorId, setSelectedManorId]` | manor | none |
| 555 | `[selectedCollectibleId, setSelectedCollectibleId]` | resources/harvesting/inventory | none |
| 556 | `[selectedDroppedItemId, setSelectedDroppedItemId]` | application composition | none |
| 557 | `[harvestTask, setHarvestTask]` | resources/harvesting/inventory | none |
| 558 | `[harvestClockMs, setHarvestClockMs]` | resources/harvesting/inventory | none |
| 559 | `[zoom, setZoom]` | world/player/movement/map | none |
| 560 | `[rttMs, setRttMs]` | session/network/startup | none |
| 561 | `[lastSnapshotAt, setLastSnapshotAt]` | application composition | none |
| 562 | `[warning, setWarning]` | application composition | none |
| 563 | `[worldProfile, setWorldProfile]` | social/chat/DM/inbox | world/player/movement/map |
| 564 | `[worldProfileStatus, setWorldProfileStatus]` | social/chat/DM/inbox | world/player/movement/map |
| 567 | `[devConsoleOpen, setDevConsoleOpen]` | developer/diagnostics | none |
| 568 | `[flagListOpen, setFlagListOpen]` | flags | none |
| 569 | `[inventoryOpen, setInventoryOpen]` | resources/harvesting/inventory | none |
| 570 | `[characterOpen, setCharacterOpen]` | application composition | none |
| 571 | `[marketOpen, setMarketOpen]` | market | none |
| 572 | `[inventorySnapshotReceived, setInventorySnapshotReceived]` | resources/harvesting/inventory | none |
| 573 | `[droppingInventoryItemKey, setDroppingInventoryItemKey]` | resources/harvesting/inventory | session/network/startup |
| 574 | `[dropSelection, setDropSelection]` | resources/harvesting/inventory | none |
| 575 | `[dropAmount, setDropAmount]` | application composition | none |
| 577 | `[droppedItemInteraction, setDroppedItemInteraction]` | application composition | none |
| 578 | `[pickupAmountDialogOpen, setPickupAmountDialogOpen]` | resources/harvesting/inventory | none |
| 579 | `[pickupAmount, setPickupAmount]` | resources/harvesting/inventory | none |
| 580 | `[performancePanelOpen, setPerformancePanelOpen]` | developer/diagnostics | none |
| 581 | `[recordingStatus, setRecordingStatus]` | developer/diagnostics | none |
| 584 | `[lastRecordingFilename, setLastRecordingFilename]` | developer/diagnostics | none |
| 585 | `[recordingMessage, setRecordingMessage]` | developer/diagnostics | none |
| 587 | `[progressionRecordingStatus, setProgressionRecordingStatus]` | combat/equipment/classes/progression | developer/diagnostics |
| 588 | `[lastProgressionFilenames, setLastProgressionFilenames]` | combat/equipment/classes/progression | none |
| 589 | `[selectedFlagScreenPoint, setSelectedFlagScreenPoint]` | flags | none |
| 593 | `[deletingFlagId, setDeletingFlagId]` | flags | none |
| 594 | `[pendingDeleteFlagId, setPendingDeleteFlagId]` | flags | none |
| 595 | `[renamingFlagId, setRenamingFlagId]` | flags | none |
| 596 | `[toastMessage, setToastMessage]` | application composition | none |
| 597 | `[updatingColor, setUpdatingColor]` | application composition | none |
| 598 | `[waterCollectMode, setWaterCollectMode]` | resources/harvesting/inventory | none |
| 599 | `[selectedCombatEntityId, setSelectedCombatEntityId]` | combat/equipment/classes/progression | none |
| 600 | `[localCombatEntity, setLocalCombatEntity]` | combat/equipment/classes/progression | none |
| 601 | `[aggressiveFallbackUntilMs, setAggressiveFallbackUntilMs]` | combat/equipment/classes/progression | none |
| 602 | `[aggressiveClockMs, setAggressiveClockMs]` | combat/equipment/classes/progression | none |
| 604 | `[selectedCombatEntity, setSelectedCombatEntity]` | combat/equipment/classes/progression | none |
| 606 | `[developerCapabilities, setDeveloperCapabilities]` | combat/equipment/classes/progression | developer/diagnostics, session/network/startup |
| 618 | `[developerToolsOpen, setDeveloperToolsOpen]` | developer/diagnostics | none |
| 619 | `[developerFlagDiagnosticsOpen, setDeveloperFlagDiagnosticsOpen]` | flags | developer/diagnostics |
| 620 | `[gameplayLatencyTraceOpen, setGameplayLatencyTraceOpen]` | developer/diagnostics | none |
| 621 | `[resourceVisionOverlayEnabled, setResourceVisionOverlayEnabled]` | resources/harvesting/inventory | none |
| 622 | `[combatDiagnosticsEnabled, setCombatDiagnosticsEnabled]` | combat/equipment/classes/progression | developer/diagnostics |
| 623 | `[movementDiagnosticsEnabled, setMovementDiagnosticsEnabled]` | world/player/movement/map | developer/diagnostics |
| 624 | `[geographyDiagnosticsEnabled, setGeographyDiagnosticsEnabled]` | developer/diagnostics | none |
| 625 | `[mobileDiagnosticsEnabled, setMobileDiagnosticsEnabled]` | developer/diagnostics | none |
| 626 | `[zoomIndicatorEnabled, setZoomIndicatorEnabled]` | world/player/movement/map | none |
| 627 | `[devGrantBusy, setDevGrantBusy]` | developer/diagnostics | none |
| 628 | `[devGrantFeedback, setDevGrantFeedback]` | developer/diagnostics | none |
| 629 | `[devWalletGold, setDevWalletGold]` | developer/diagnostics | none |
| 630 | `[mobSpawnerOpen, setMobSpawnerOpen]` | world/player/movement/map | developer/diagnostics |
| 631 | `[mobSpawnArchetype, setMobSpawnArchetype]` | world/player/movement/map | developer/diagnostics |
| 632 | `[flagBuild, setFlagBuild]` | flags | none |
| 636 | `[flagBuildQueued, setFlagBuildQueued]` | flags | none |
| 639 | `[queuedMapFlagBuild, setQueuedMapFlagBuild]` | flags | world/player/movement/map |
| 640 | `[flagBuildClock, setFlagBuildClock]` | flags | developer/diagnostics |
| 641 | `[flagQuotePreparing, setFlagQuotePreparing]` | flags | none |
| 642 | `[flagPlacementPreviewActive, setFlagPlacementPreviewActive]` | flags | none |
| 643 | `[flagClaimRadiusM, setFlagClaimRadiusM]` | flags | none |
| 644 | `[teleportMode, setTeleportMode]` | world/player/movement/map | none |
| 645 | `[progression, setProgression]` | combat/equipment/classes/progression | none |
| 646 | `[masteries, setMasteries]` | combat/equipment/classes/progression | none |
| 647 | `[equipment, setEquipment]` | combat/equipment/classes/progression | none |
| 648 | `[equipmentBusy, setEquipmentBusy]` | combat/equipment/classes/progression | none |
| 656 | `[, setPendingKitActivation]` | combat/equipment/classes/progression | none |
| 662 | `[foundingCity, setFoundingCity]` | settlements/cities/Kingdom | none |
| 663 | `[cityActionBusy, setCityActionBusy]` | settlements/cities/Kingdom | none |
| 664 | `[joiningCity, setJoiningCity]` | settlements/cities/Kingdom | none |
| 665 | `[leavingCity, setLeavingCity]` | settlements/cities/Kingdom | none |
| 666 | `[pendingLeaveCityId, setPendingLeaveCityId]` | settlements/cities/Kingdom | none |
| 667 | `[selectedProfilePlayerId, setSelectedProfilePlayerId]` | social/chat/DM/inbox | world/player/movement/map |
| 668 | `[profileExpanded, setProfileExpanded]` | social/chat/DM/inbox | none |
| 669 | `[profileRequiresVisibility, setProfileRequiresVisibility]` | social/chat/DM/inbox | none |
| 670 | `[socialRefreshToken, setSocialRefreshToken]` | social/chat/DM/inbox | none |
| 671 | `[playerActionsTarget, setPlayerActionsTarget]` | world/player/movement/map | none |
| 672 | `[directMessagesOpen, setDirectMessagesOpen]` | social/chat/DM/inbox | none |
| 673 | `[directMessagesMinimized, setDirectMessagesMinimized]` | social/chat/DM/inbox | none |
| 675 | `[directMessageBanner, setDirectMessageBanner]` | social/chat/DM/inbox | none |
| 676 | `[kingdomState, setKingdomState]` | settlements/cities/Kingdom | none |
| 678 | `[kingdomPanelOpen, setKingdomPanelOpen]` | settlements/cities/Kingdom | none |
| 679 | `[selectedKingdomId, setSelectedKingdomId]` | settlements/cities/Kingdom | none |
| 681 | `[selectedPublicKingdom, setSelectedPublicKingdom]` | settlements/cities/Kingdom | none |
| 682 | `[publicKingdomError, setPublicKingdomError]` | settlements/cities/Kingdom | none |
| 683 | `[classSnapshot, setClassSnapshot]` | combat/equipment/classes/progression | none |
| 684 | `[party, setParty]` | party | none |
| 685 | `[partyInvites, setPartyInvites]` | party | none |
| 686 | `[partyOutgoingInvites, setPartyOutgoingInvites]` | party | none |
| 687 | `[partyPlayerNames, setPartyPlayerNames]` | party | world/player/movement/map |
| 688 | `[partyInviteClock, setPartyInviteClock]` | party | none |
| 689 | `[travelInbox, setTravelInbox]` | travel | social/chat/DM/inbox |
| 690 | `[travelInboxServerTime, setTravelInboxServerTime]` | travel | social/chat/DM/inbox |
| 691 | `[travelInboxServerOffsetMs, setTravelInboxServerOffsetMs]` | travel | social/chat/DM/inbox |
| 692 | `[travelInboxOpen, setTravelInboxOpen]` | travel | social/chat/DM/inbox |
| 693 | `[petChamberOpen, setPetChamberOpen]` | pets/expeditions | none |
| 694 | `[petState, setPetState]` | pets/expeditions | none |
| 695 | `[petBusy, setPetBusy]` | pets/expeditions | none |
| 696 | `[petError, setPetError]` | pets/expeditions | none |
| 697 | `[petReaction, setPetReaction]` | pets/expeditions | none |
| 698 | `[petMemoryBusy, setPetMemoryBusy]` | pets/expeditions | none |
| 699 | `[petMemoryFeedback, setPetMemoryFeedback]` | pets/expeditions | none |
| 700 | `[petDebugState, setPetDebugState]` | pets/expeditions | none |
| 701 | `[petDebugBusy, setPetDebugBusy]` | pets/expeditions | none |
| 702 | `[petDebugFeedback, setPetDebugFeedback]` | pets/expeditions | none |
| 703 | `[petExpeditions, setPetExpeditions]` | pets/expeditions | none |
| 704 | `[petExpeditionBusy, setPetExpeditionBusy]` | pets/expeditions | none |
| 705 | `[petExpeditionFeedback, setPetExpeditionFeedback]` | pets/expeditions | none |
| 706 | `[petExpeditionDebug, setPetExpeditionDebug]` | pets/expeditions | none |
| 707 | `[petExpeditionDebugBusy, setPetExpeditionDebugBusy]` | pets/expeditions | none |
| 708 | `[petExpeditionDebugFeedback, setPetExpeditionDebugFeedback]` | pets/expeditions | none |
| 709 | `[worldMapOpen, setWorldMapOpen]` | world/player/movement/map | none |
| 711 | `[worldMapSnapshot, setWorldMapSnapshot]` | world/player/movement/map | none |
| 712 | `[abilityTargetSelection, setAbilityTargetSelection]` | combat/equipment/classes/progression | none |
| 713 | `[classPanelOpen, setClassPanelOpen]` | combat/equipment/classes/progression | none |
| 714 | `[classPanelInitialSection, setClassPanelInitialSection]` | combat/equipment/classes/progression | none |
| 715 | `[classBusy, setClassBusy]` | combat/equipment/classes/progression | none |
| 716 | `[devProgressionOpen, setDevProgressionOpen]` | combat/equipment/classes/progression | developer/diagnostics |
| 717 | `[devProgressionPendingType, setDevProgressionPendingType]` | combat/equipment/classes/progression | developer/diagnostics |
| 718 | `[devSubclassPending, setDevSubclassPending]` | combat/equipment/classes/progression | developer/diagnostics |
| 719 | `[devProgressionError, setDevProgressionError]` | combat/equipment/classes/progression | developer/diagnostics |
| 746 | `[activeMap, setActiveMap]` | world/player/movement/map | none |
| 751 | `[directMessageStore]` | social/chat/DM/inbox | world/player/movement/map |
| 765 | `[chatStore]` | social/chat/DM/inbox | world/player/movement/map |
| 767 | `[chatHistoryRequests]` | social/chat/DM/inbox | none |
| 7057 | `[dimensions, setDimensions]` | application composition | none |
| 7058 | `[abilityCount, setAbilityCount]` | combat/equipment/classes/progression | none |

## Ref inventory

| Line | Hook binding | Primary owner | Secondary observers |
| --- | --- | --- | --- |
| 501 | `gameAppRenderCountRef` | application composition | none |
| 509 | `startupRef` | session/network/startup | none |
| 649 | `equipmentMutationRequestRef` | combat/equipment/classes/progression | none |
| 650 | `pendingKitActivationRef` | combat/equipment/classes/progression | none |
| 677 | `kingdomSpatialRevisionRef` | settlements/cities/Kingdom | none |
| 744 | `mapContainerRef` | world/player/movement/map | none |
| 745 | `mapRef` | world/player/movement/map | none |
| 747 | `overlayRef` | application composition | none |
| 748 | `kingdomMapRef` | settlements/cities/Kingdom | world/player/movement/map |
| 749 | `publicKingdomRequestRef` | settlements/cities/Kingdom | none |
| 750 | `clientRef` | application composition | none |
| 757 | `directMessageBootstrappedRef` | social/chat/DM/inbox | none |
| 758 | `directMessageRecoveringRef` | social/chat/DM/inbox | session/network/startup |
| 759 | `directMessagePanelVisibleRef` | social/chat/DM/inbox | none |
| 760 | `directMessageCombatSuppressionRef` | social/chat/DM/inbox | combat/equipment/classes/progression |
| 761 | `directMessageSendRequestsRef` | social/chat/DM/inbox | world/player/movement/map |
| 762 | `directMessageOpenRequestsRef` | social/chat/DM/inbox | world/player/movement/map |
| 763 | `directMessageNotifiedEventsRef` | social/chat/DM/inbox | none |
| 764 | `directMessageLastReadRequestRef` | social/chat/DM/inbox | world/player/movement/map |
| 766 | `chatStoreRef` | social/chat/DM/inbox | none |
| 768 | `marketControllerRef` | market | none |
| 778 | `combatStoreRef` | combat/equipment/classes/progression | none |
| 779 | `playerRenderTimelineRef` | world/player/movement/map | none |
| 780 | `manorMovementTimelineRef` | manor | world/player/movement/map |
| 781 | `localMovementRequestsRef` | world/player/movement/map | none |
| 782 | `queuedMapFlagBuildRef` | flags | world/player/movement/map |
| 783 | `pendingTravelRequestIdRef` | travel | none |
| 784 | `completedTravelArrivalRequestIdsRef` | travel | none |
| 785 | `relocationRevisionRef` | travel | world/player/movement/map |
| 786 | `resourceVisionRevisionRef` | resources/harvesting/inventory | none |
| 787 | `populationZoneProjectionRef` | application composition | none |
| 788 | `inventoryDropRequestGateRef` | resources/harvesting/inventory | none |
| 789 | `manorPendingRef` | manor | none |
| 791 | `petPendingRef` | pets/expeditions | none |
| 792 | `petMemoryPendingRef` | pets/expeditions | none |
| 793 | `petDebugPendingRef` | pets/expeditions | none |
| 794 | `petExpeditionPendingRef` | pets/expeditions | none |
| 795 | `petExpeditionDebugPendingRef` | pets/expeditions | none |
| 796 | `locationModeRef` | world/player/movement/map | none |
| 797 | `manorSessionRef` | manor | session/network/startup |
| 798 | `pendingWorldRestoreRef` | world/player/movement/map | none |
| 799 | `droppedItemPickupRequestGateRef` | resources/harvesting/inventory | none |
| 800 | `overlayInteractionGateRef` | application composition | none |
| 857 | `draggedMapRef` | world/player/movement/map | none |
| 858 | `zoomingMapRef` | world/player/movement/map | none |
| 859 | `programmaticCameraMoveRef` | world/player/movement/map | none |
| 860 | `programmaticCameraEndTimerRef` | world/player/movement/map | none |
| 861 | `cameraActionGenerationRef` | world/player/movement/map | none |
| 862 | `lastDebugZoomAtRef` | world/player/movement/map | none |
| 863 | `zoomRef` | world/player/movement/map | none |
| 864 | `selectedFlagScreenPointRef` | flags | none |
| 865 | `lastAggressiveVisitToastAtRef` | combat/equipment/classes/progression | none |
| 866 | `aggressiveUntilMsRef` | combat/equipment/classes/progression | none |
| 867 | `harvestRequestSentRef` | resources/harvesting/inventory | none |
| 868 | `pendingHarvestCancelNodeRef` | resources/harvesting/inventory | none |
| 869 | `repeatableReadyRefreshRef` | application composition | none |
| 871 | `harvestTaskRef` | resources/harvesting/inventory | none |
| 872 | `selectedCollectibleIdRef` | resources/harvesting/inventory | none |
| 873 | `selectedDroppedItemIdRef` | application composition | none |
| 874 | `selectedManorIdRef` | manor | none |
| 875 | `droppedItemInteractionRef` | application composition | none |
| 876 | `localPlayerRef` | world/player/movement/map | none |
| 877 | `manorDisplayColorRef` | manor | none |
| 878 | `waterCollectModeRef` | resources/harvesting/inventory | none |
| 879 | `selectedCombatEntityIdRef` | combat/equipment/classes/progression | none |
| 880 | `mobSpawnArchetypeRef` | world/player/movement/map | developer/diagnostics |
| 881 | `teleportModeRef` | world/player/movement/map | none |
| 882 | `teleportRequestRef` | world/player/movement/map | none |
| 883 | `flagBuildMarkerRef` | flags | world/player/movement/map |
| 884 | `placementPreviewMarkerRef` | world/player/movement/map | none |
| 885 | `flagPlacementValidationPopupRef` | flags | world/player/movement/map |
| 886 | `flagPlacementPreviewTerrainRef` | flags | none |
| 887 | `flagPlacementValidationGateRef` | flags | none |
| 888 | `flagBuildIntentRef` | flags | none |
| 889 | `surveyStartedAtRef` | application composition | none |
| 890 | `gameEnteredMilestoneRef` | application composition | none |
| 891 | `firstPlayerSnapshotRef` | world/player/movement/map | none |
| 892 | `playerDeltaSequenceRef` | world/player/movement/map | none |
| 893 | `lastWorldResyncRequestAtRef` | world/player/movement/map | none |
| 894 | `combatServerClockOffsetMsRef` | combat/equipment/classes/progression | none |
| 895 | `pendingWorldResyncReasonRef` | world/player/movement/map | none |
| 896 | `firstFlagsSnapshotRef` | flags | none |
| 897 | `renderStateRef` | manor | settlements/cities/Kingdom, flags, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map |
| 916 | `selectedFlagRef` | flags | none |
| 917 | `selectedCityIdRef` | settlements/cities/Kingdom | none |

## Effect inventory

| Line | Hook binding | Primary owner | Secondary observers |
| --- | --- | --- | --- |
| 383 | `(inline)` | session/network/startup | none |
| 419 | `(inline)` | application composition | none |
| 721 | `(inline)` | developer/diagnostics | session/network/startup |
| 724 | `(inline)` | flags | resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map, developer/diagnostics |
| 740 | `(inline)` | flags | developer/diagnostics |
| 920 | `(inline)` | travel | world/player/movement/map |
| 930 | `(inline)` | settlements/cities/Kingdom | social/chat/DM/inbox, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map, developer/diagnostics, session/network/startup |
| 1004 | `(inline)` | party | social/chat/DM/inbox, world/player/movement/map, session/network/startup |
| 1035 | `(inline)` | party | world/player/movement/map |
| 1062 | `(inline)` | social/chat/DM/inbox | combat/equipment/classes/progression, world/player/movement/map |
| 1100 | `(inline)` | manor | none |
| 1157 | `(inline)` | world/player/movement/map | developer/diagnostics |
| 1166 | `(inline)` | travel | flags, world/player/movement/map, developer/diagnostics |
| 1245 | `(inline)` | combat/equipment/classes/progression | none |
| 1592 | `(inline)` | developer/diagnostics | none |
| 1596 | `(inline)` | developer/diagnostics | none |
| 1612 | `(inline)` | combat/equipment/classes/progression | developer/diagnostics |
| 1639 | `(inline)` | application composition | none |
| 1647 | `(inline)` | resources/harvesting/inventory | none |
| 1651 | `(inline)` | flags | world/player/movement/map |
| 1674 | `(inline)` | manor | session/network/startup |
| 1676 | `(inline)` | manor | none |
| 1682 | `(inline)` | application composition | none |
| 1874 | `(inline)` | manor | resources/harvesting/inventory, world/player/movement/map, developer/diagnostics |
| 3720 | `(inline)` | social/chat/DM/inbox | none |
| 3733 | `(inline)` | social/chat/DM/inbox | none |
| 3752 | `(inline)` | social/chat/DM/inbox | none |
| 3758 | `(inline)` | settlements/cities/Kingdom | flags, world/player/movement/map, developer/diagnostics, session/network/startup |
| 4263 | `(inline)` | session/network/startup | none |
| 4269 | `(inline)` | session/network/startup | none |
| 4273 | `(inline)` | flags | world/player/movement/map |
| 4279 | `(inline)` | travel | flags, world/player/movement/map |
| 4293 | `(inline)` | flags | combat/equipment/classes/progression |
| 4299 | `(inline)` | flags | resources/harvesting/inventory, world/player/movement/map |
| 4309 | `(inline)` | world/player/movement/map | none |
| 4311 | `(inline)` | world/player/movement/map | session/network/startup |
| 4322 | `(inline)` | manor | settlements/cities/Kingdom, social/chat/DM/inbox, flags, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map, developer/diagnostics |
| 4384 | `(inline)` | resources/harvesting/inventory | session/network/startup |
| 4400 | `(inline)` | settlements/cities/Kingdom | world/player/movement/map, session/network/startup |
| 4430 | `(inline)` | settlements/cities/Kingdom | flags, world/player/movement/map |
| 4435 | `(inline)` | settlements/cities/Kingdom | session/network/startup |
| 4444 | `(inline)` | flags | none |
| 4453 | `(inline)` | settlements/cities/Kingdom | session/network/startup |
| 4460 | `(inline)` | resources/harvesting/inventory | none |
| 4471 | `(inline)` | world/player/movement/map | none |
| 4483 | `(inline)` | resources/harvesting/inventory | none |
| 4491 | `(inline)` | resources/harvesting/inventory | world/player/movement/map |
| 4525 | `(inline)` | resources/harvesting/inventory | world/player/movement/map, session/network/startup |
| 4579 | `(inline)` | resources/harvesting/inventory | none |
| 4586 | `(inline)` | resources/harvesting/inventory | none |
| 4601 | `(inline)` | resources/harvesting/inventory | combat/equipment/classes/progression |
| 4607 | `(inline)` | flags | none |
| 4611 | `(inline)` | flags | developer/diagnostics |
| 4617 | `(inline)` | world/player/movement/map | session/network/startup |
| 4626 | `(inline)` | flags | combat/equipment/classes/progression, world/player/movement/map |
| 4684 | `(inline)` | flags | combat/equipment/classes/progression, world/player/movement/map |
| 4724 | `(inline)` | flags | combat/equipment/classes/progression, world/player/movement/map, developer/diagnostics |
| 4766 | `(inline)` | flags | world/player/movement/map |
| 4771 | `(inline)` | flags | combat/equipment/classes/progression |
| 4786 | `(inline)` | world/player/movement/map | none |
| 4840 | `(inline)` | travel | flags, world/player/movement/map, session/network/startup |
| 4863 | `(inline)` | flags | combat/equipment/classes/progression, world/player/movement/map, session/network/startup |
| 4972 | `(inline)` | market | settlements/cities/Kingdom, social/chat/DM/inbox, flags, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map, developer/diagnostics, session/network/startup |
| 5639 | `(inline)` | pets/expeditions | market, travel, settlements/cities/Kingdom, social/chat/DM/inbox, flags, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map, developer/diagnostics |
| 7060 | `(inline)` | combat/equipment/classes/progression | world/player/movement/map, session/network/startup |

## Callback inventory

| Line | Hook binding | Primary owner | Secondary observers |
| --- | --- | --- | --- |
| 372 | `checkRelease` | world/player/movement/map | session/network/startup |
| 415 | `updateNow` | application composition | none |
| 512 | `handlePhoneDrawerStateChange` | developer/diagnostics | none |
| 803 | `sendDirectMessageCandidate` | social/chat/DM/inbox | session/network/startup |
| 815 | `requestDirectMessageOpen` | social/chat/DM/inbox | world/player/movement/map |
| 822 | `openDirectMessagePeer` | social/chat/DM/inbox | world/player/movement/map |
| 841 | `openChatSender` | social/chat/DM/inbox | world/player/movement/map |
| 848 | `handleRelationshipMutated` | social/chat/DM/inbox | world/player/movement/map |
| 1256 | `cancelQueuedMapFlagBuild` | flags | world/player/movement/map |
| 1263 | `requestLocalMovement` | travel | flags, world/player/movement/map, developer/diagnostics, session/network/startup |
| 1329 | `queueMapFlagBuild` | travel | flags, world/player/movement/map, developer/diagnostics, session/network/startup |
| 1356 | `cancelHarvestSelection` | resources/harvesting/inventory | world/player/movement/map, session/network/startup |
| 1380 | `updateDroppedItemInteraction` | application composition | none |
| 1388 | `clearDroppedItemInteraction` | resources/harvesting/inventory | world/player/movement/map, session/network/startup |
| 1427 | `attemptDroppedItemPickup` | resources/harvesting/inventory | world/player/movement/map, session/network/startup |
| 1450 | `attemptReadyDroppedItemPickup` | resources/harvesting/inventory | none |
| 1457 | `confirmDroppedItemPickup` | resources/harvesting/inventory | world/player/movement/map |
| 1482 | `selectDroppedItemForPickup` | social/chat/DM/inbox | flags, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map, session/network/startup |
| 1507 | `finishProgressionRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1521 | `startProgressionRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1530 | `stopProgressionRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1540 | `resetProgressionRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1547 | `finishPerformanceRecording` | developer/diagnostics | none |
| 1559 | `startPerformanceRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1573 | `stopPerformanceRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1583 | `resetPerformanceRecording` | combat/equipment/classes/progression | developer/diagnostics |
| 1716 | `clearProgrammaticCameraEndTimer` | world/player/movement/map | none |
| 1723 | `finishProgrammaticCameraMove` | flags | world/player/movement/map |
| 1736 | `scheduleProgrammaticCameraMoveEnd` | world/player/movement/map | none |
| 1747 | `beginProgrammaticCameraMove` | world/player/movement/map | none |
| 1760 | `centerCamera` | world/player/movement/map | developer/diagnostics |
| 1795 | `receiveInventorySnapshot` | resources/harvesting/inventory | world/player/movement/map |
| 1803 | `refreshCombatUi` | combat/equipment/classes/progression | world/player/movement/map, developer/diagnostics |
| 1827 | `snapRespawnedPlayers` | combat/equipment/classes/progression | world/player/movement/map, developer/diagnostics |
| 1845 | `requestWorldResync` | combat/equipment/classes/progression | world/player/movement/map, developer/diagnostics |
| 1905 | `handleDirectMessageFrame` | social/chat/DM/inbox | world/player/movement/map, session/network/startup |
| 2012 | `handleMessage` | pets/expeditions | market, travel, social/chat/DM/inbox, resources/harvesting/inventory, combat/equipment/classes/progression, world/player/movement/map |
| 4793 | `requestBuildFlag` | flags | world/player/movement/map, developer/diagnostics |
| 4873 | `runTraceStationaryQuote` | flags | developer/diagnostics |
| 4881 | `runTraceMoveStopQuote` | flags | world/player/movement/map, developer/diagnostics, session/network/startup |
| 4905 | `runTraceMoveStopBuild` | flags | world/player/movement/map, developer/diagnostics |
| 4910 | `runTraceReliability` | combat/equipment/classes/progression | world/player/movement/map, developer/diagnostics |
| 4918 | `requestCityFoundingPreview` | settlements/cities/Kingdom | flags |
| 4925 | `confirmFoundCity` | settlements/cities/Kingdom | flags |
| 4932 | `requestCityFlagConversion` | settlements/cities/Kingdom | flags |
| 4939 | `requestJoinCity` | settlements/cities/Kingdom | none |
| 4946 | `requestLeaveCity` | settlements/cities/Kingdom | none |
| 4951 | `confirmLeaveCity` | settlements/cities/Kingdom | none |
| 4958 | `requestClaimCityMayor` | settlements/cities/Kingdom | none |
| 4965 | `requestRelinquishCityMayor` | settlements/cities/Kingdom | none |

## Domain JSX blocks

| Line | JSX block | Domain | View owner |
| --- | --- | --- | --- |
| 389 | `<ClientStatusScreen>` | application composition | `GameApp` |
| 392 | `<ClientUpdateScreen>` | application composition | `GameApp` |
| 395 | `<UiEnvironmentProvider>` | application composition | `GameApp` |
| 433 | `<ClientStatusScreen>` | application composition | `GameApp` |
| 5701 | `<WorldMapOverlay>` | world/player/movement/map | `worldGameplayClient` |
| 5762 | `<MapZoomIndicator>` | world/player/movement/map | `worldGameplayClient` |
| 5787 | `<ConnectionRecoveryScreen>` | session/network/startup | `sessionClient` |
| 5789 | `<ConnectionRecoveryScreen>` | session/network/startup | `sessionClient` |
| 5797 | `<KeyboardDebugPanel>` | application composition | `GameApp` |
| 5798 | `<PhoneHud>` | application composition | `GameApp` |
| 5907 | `<SelectedFlagMapLabel>` | flags | `flagClient` |
| 5924 | `<TopBar>` | application composition | `GameApp` |
| 5947 | `<PlayerActionsSurface>` | world/player/movement/map | `worldGameplayClient` |
| 5966 | `<ProgressionHud>` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5974 | `<StatusToast>` | application composition | `GameApp` |
| 5994 | `<DirectMessagesPanel>` | social/chat/DM/inbox | `socialClient` |
| 6140 | `<SocialProfileOverlay>` | social/chat/DM/inbox | `socialClient` |
| 6219 | `<TravelInboxPanel>` | travel | `travelClient` |
| 6245 | `<KingdomPanel>` | settlements/cities/Kingdom | `settlementClient` |
| 6285 | `<MarketOverlay>` | market | `marketClient` |
| 6327 | `<PickupDroppedItemDialog>` | resources/harvesting/inventory | `harvestingClient` |
| 6341 | `<BottomActionBar>` | application composition | `GameApp` |
| 6464 | `<ManorGuestPanel>` | manor | `manorClient` |
| 6487 | `<ClassesPanel>` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 6525 | `<CharacterPanel>` | application composition | `GameApp` |
| 6569 | `<InventoryPanel>` | resources/harvesting/inventory | `harvestingClient` |
| 6617 | `<DropItemDialog>` | application composition | `GameApp` |
| 6632 | `<ManorStoragePanel>` | manor | `manorClient` |
| 6640 | `<ResourcePanel>` | resources/harvesting/inventory | `harvestingClient` |
| 6646 | `<DebugPanel>` | application composition | `GameApp` |
| 6668 | `<PerformancePanel>` | developer/diagnostics | `developerClient` |
| 6699 | `<DeveloperToolsPanel>` | developer/diagnostics | `developerClient` |
| 6839 | `<GameplayLatencyTracePanel>` | developer/diagnostics | `developerClient` |
| 6855 | `<FlagPanel>` | flags | `flagClient` |
| 6896 | `<CityPanel>` | settlements/cities/Kingdom | `settlementClient` |
| 6915 | `<ConfirmDialog>` | application composition | `GameApp` |
| 6925 | `<ConfirmDialog>` | application composition | `GameApp` |
| 6934 | `<FlagListPanel>` | flags | `flagClient` |
| 6969 | `<ConfirmDialog>` | application composition | `GameApp` |
| 6980 | `<DevConsole>` | developer/diagnostics | `developerClient` |

## Direct GameClient calls

All 143 syntactic optional command calls are mapped below. Other
`clientRef.current` occurrences are assignments, guards, or reads owned by session/core.

| Line | Method | Domain | Replacement boundary |
| --- | --- | --- | --- |
| 805 | `sendDirectMessage` | social/chat/DM/inbox | `socialClient` |
| 816 | `openDirectMessage` | social/chat/DM/inbox | `socialClient` |
| 1210 | `placeFlag` | flags | `flagClient` |
| 1283 | `moveTo` | travel | `travelClient` |
| 1371 | `cancelHarvest` | resources/harvesting/inventory | `harvestingClient` |
| 1439 | `pickupDroppedItem` | resources/harvesting/inventory | `harvestingClient` |
| 1858 | `requestWorldResync` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 1895 | `requestNearbyCollectibles` | resources/harvesting/inventory | `harvestingClient` |
| 1924 | `syncDirectMessages` | social/chat/DM/inbox | `socialClient` |
| 1947 | `acknowledgeDirectMessageDelivery` | social/chat/DM/inbox | `socialClient` |
| 1970 | `acknowledgeDirectMessageEvents` | social/chat/DM/inbox | `socialClient` |
| 1982 | `syncDirectMessages` | social/chat/DM/inbox | `socialClient` |
| 2008 | `syncDirectMessages` | social/chat/DM/inbox | `socialClient` |
| 2023 | `requestNearbyCollectibles` | resources/harvesting/inventory | `harvestingClient` |
| 2071 | `requestPetExpeditionDashboard` | pets/expeditions | `petClient` |
| 2281 | `selectChatChannel` | social/chat/DM/inbox | `socialClient` |
| 2334 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 2335 | `requestWorldMapDestinations` | world/player/movement/map | `worldGameplayClient` |
| 2428 | `syncDirectMessages` | social/chat/DM/inbox | `socialClient` |
| 2432 | `bootstrapDirectMessages` | social/chat/DM/inbox | `socialClient` |
| 2982 | `requestNearbyCollectibles` | resources/harvesting/inventory | `harvestingClient` |
| 3012 | `cancelHarvest` | resources/harvesting/inventory | `harvestingClient` |
| 3263 | `requestCityInfo` | settlements/cities/Kingdom | `settlementClient` |
| 3551 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 3742 | `updateDirectMessageRead` | social/chat/DM/inbox | `socialClient` |
| 3965 | `spawnMob` | world/player/movement/map | `worldGameplayClient` |
| 3975 | `collectWaterAtCoordinate` | resources/harvesting/inventory | `harvestingClient` |
| 4085 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 4313 | `recoverIfNeeded` | session/network/startup | `sessionClient` |
| 4389 | `requestNearbyCollectibles` | resources/harvesting/inventory | `harvestingClient` |
| 4392 | `requestNearbyCollectibles` | resources/harvesting/inventory | `harvestingClient` |
| 4437 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 4439 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 4456 | `requestCityInfo` | settlements/cities/Kingdom | `settlementClient` |
| 4541 | `cancelHarvest` | resources/harvesting/inventory | `harvestingClient` |
| 4558 | `startHarvest` | resources/harvesting/inventory | `harvestingClient` |
| 4567 | `completeHarvest` | resources/harvesting/inventory | `harvestingClient` |
| 4594 | `requestNearbyCollectibles` | resources/harvesting/inventory | `harvestingClient` |
| 4620 | `requestWorldMapDestinations` | world/player/movement/map | `worldGameplayClient` |
| 4748 | `cancelFlagBuild` | flags | `flagClient` |
| 4922 | `previewCityFounding` | settlements/cities/Kingdom | `settlementClient` |
| 4929 | `foundCity` | settlements/cities/Kingdom | `settlementClient` |
| 4936 | `convertCityFlag` | settlements/cities/Kingdom | `settlementClient` |
| 4943 | `joinCity` | settlements/cities/Kingdom | `settlementClient` |
| 4955 | `leaveCity` | settlements/cities/Kingdom | `settlementClient` |
| 4962 | `claimCityMayor` | settlements/cities/Kingdom | `settlementClient` |
| 4969 | `relinquishCityMayor` | settlements/cities/Kingdom | `settlementClient` |
| 5000 | `useUniversalTaunt` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5002 | `useResetAbility` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5003 | `useNormalAbility` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5222 | `visitFlag` | travel | `travelClient` |
| 5267 | `startHarvest` | resources/harvesting/inventory | `harvestingClient` |
| 5288 | `depositManorItem` | manor | `manorClient` |
| 5291 | `dropItem` | resources/harvesting/inventory | `harvestingClient` |
| 5303 | `buildManor` | manor | `manorClient` |
| 5315 | `destroyManor` | manor | `manorClient` |
| 5323 | `jumpToManor` | manor | `manorClient` |
| 5333 | `enterManor` | manor | `manorClient` |
| 5340 | `requestManorGuests` | manor | `manorClient` |
| 5347 | `exitManor` | manor | `manorClient` |
| 5357 | `manorMoveTo` | manor | `manorClient` |
| 5363 | `openManorStorage` | manor | `manorClient` |
| 5372 | `withdrawManorItem` | manor | `manorClient` |
| 5392 | `startAttack` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5399 | `updateClassLoadout` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5407 | `activateSubclass` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5415 | `activateClass` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5424 | `adjustOwnDevProgression` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5435 | `setOwnDevSubclassUnlock` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 5444 | `disconnect` | session/network/startup | `sessionClient` |
| 5481 | `activateCombatKit` | resources/harvesting/inventory | `harvestingClient` |
| 5501 | `cancelFlagBuild` | flags | `flagClient` |
| 5502 | `cancelFlagBuild` | flags | `flagClient` |
| 5512 | `cancelFlagBuild` | flags | `flagClient` |
| 5514 | `cancelFlagBuild` | flags | `flagClient` |
| 5590 | `requestPetExpeditionDashboard` | pets/expeditions | `petClient` |
| 5593 | `checkInPet` | pets/expeditions | `petClient` |
| 5595 | `requestPetState` | pets/expeditions | `petClient` |
| 5602 | `requestWorldMapDestinations` | world/player/movement/map | `worldGameplayClient` |
| 5606 | `devTeleport` | world/player/movement/map | `worldGameplayClient` |
| 5659 | `requestTravelInbox` | travel | `travelClient` |
| 5660 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 5679 | `requestWorldMapDestinations` | world/player/movement/map | `worldGameplayClient` |
| 5749 | `visitWorldMapCity` | settlements/cities/Kingdom | `settlementClient` |
| 5754 | `visitWorldMapKingdom` | travel | `travelClient` |
| 5838 | `requestPetState` | pets/expeditions | `petClient` |
| 5841 | `adoptPet` | pets/expeditions | `petClient` |
| 5844 | `checkInPet` | pets/expeditions | `petClient` |
| 5847 | `feedPet` | pets/expeditions | `petClient` |
| 5850 | `interactPet` | pets/expeditions | `petClient` |
| 5853 | `viewCompletedPet` | pets/expeditions | `petClient` |
| 5856 | `returnToGrowingPet` | pets/expeditions | `petClient` |
| 5860 | `requestPetMemories` | pets/expeditions | `petClient` |
| 5871 | `requestPetExpeditionDashboard` | pets/expeditions | `petClient` |
| 5876 | `selectPetExpeditionEcho` | pets/expeditions | `petClient` |
| 5886 | `startPetExpedition` | pets/expeditions | `petClient` |
| 5893 | `acknowledgePetExpedition` | pets/expeditions | `petClient` |
| 5898 | `trainPetExpeditionStat` | pets/expeditions | `petClient` |
| 5903 | `treatPetExpeditionEcho` | pets/expeditions | `petClient` |
| 5936 | `requestTravelInbox` | travel | `travelClient` |
| 5961 | `invitePartyMember` | party | `partyClient` |
| 6009 | `respondTravelInvite` | travel | `travelClient` |
| 6019 | `respondTravelInvite` | travel | `travelClient` |
| 6024 | `cancelTravelInvite` | travel | `travelClient` |
| 6029 | `acceptPartyInvite` | party | `partyClient` |
| 6032 | `declinePartyInvite` | party | `partyClient` |
| 6039 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6049 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6109 | `requestDirectMessageHistory` | social/chat/DM/inbox | `socialClient` |
| 6112 | `listDirectMessages` | social/chat/DM/inbox | `socialClient` |
| 6120 | `setDirectMessageMute` | social/chat/DM/inbox | `socialClient` |
| 6137 | `setDirectMessagePreferences` | social/chat/DM/inbox | `socialClient` |
| 6164 | `invitePartyMember` | party | `partyClient` |
| 6165 | `sendTravelInvite` | travel | `travelClient` |
| 6202 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6208 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6228 | `respondTravelInvite` | travel | `travelClient` |
| 6238 | `respondTravelInvite` | travel | `travelClient` |
| 6241 | `cancelTravelInvite` | travel | `travelClient` |
| 6261 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6263 | `sendKingdomChat` | settlements/cities/Kingdom | `settlementClient` |
| 6414 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6455 | `cancelManorEntry` | manor | `manorClient` |
| 6469 | `kickManorGuest` | manor | `manorClient` |
| 6472 | `banManorGuest` | manor | `manorClient` |
| 6475 | `unbanManorGuest` | manor | `manorClient` |
| 6533 | `equipItem` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 6538 | `unequipItem` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 6545 | `toggleReadiedWeapon` | resources/harvesting/inventory | `harvestingClient` |
| 6582 | `equipItem` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 6587 | `upgradeEquipment` | combat/equipment/classes/progression | `combatEquipmentClient` |
| 6721 | `grantOwnDevelopmentAssets` | application composition | `GameApp` |
| 6726 | `grantOwnDevelopmentAssets` | resources/harvesting/inventory | `harvestingClient` |
| 6730 | `grantOwnDevelopmentAssets` | resources/harvesting/inventory | `harvestingClient` |
| 6741 | `clearMobs` | developer/diagnostics | `developerClient` |
| 6757 | `devVisitMine` | world/player/movement/map | `worldGameplayClient` |
| 6776 | `requestPetDebugState` | pets/expeditions | `petClient` |
| 6787 | `petDebugAction` | pets/expeditions | `petClient` |
| 6801 | `requestPetExpeditionDebugState` | pets/expeditions | `petClient` |
| 6816 | `petExpeditionDebugAction` | pets/expeditions | `petClient` |
| 6863 | `requestKingdomState` | settlements/cities/Kingdom | `settlementClient` |
| 6888 | `reinforceFlag` | flags | `flagClient` |
| 6908 | `visitCity` | settlements/cities/Kingdom | `settlementClient` |

## ServerMessage checks

| Line | Form | Expression | Purpose |
| --- | --- | --- | --- |
| 490 | if | `message.type === "EQUIPMENT_SNAPSHOT"` | pre-route special case/guard |
| 2018 | if | `message.type === "MARKET_MUTATION_RESULT" && marketMutationChangesInventory(message.result)` | pre-route special case/guard |
| 2062 | switch | `message.type` | central primary switch |

## Cross-domain hooks

| Line | Kind | Binding | Ordered domains | Baseline intent |
| --- | --- | --- | --- | --- |
| 525 | useState | `[manors, setManors]` | manor → world/player/movement/map | useState<ManorWorldSnapshot[]>([]) |
| 526 | useState | `[ownManor, setOwnManor]` | manor → world/player/movement/map | useState<ManorWorldSnapshot \| null>(null) |
| 539 | useState | `[inventory, setInventory]` | resources/harvesting/inventory → world/player/movement/map | useState<PlayerInventorySnapshot>(() => emptyInventoryForPlayer(playerId) ) |
| 545 | useState | `[manorSession, setManorSession]` | manor → session/network/startup | useState<ManorClientSession \| null>(null) |
| 563 | useState | `[worldProfile, setWorldProfile]` | social/chat/DM/inbox → world/player/movement/map | useState<WorldDebugProfile \| null>(null) |
| 564 | useState | `[worldProfileStatus, setWorldProfileStatus]` | social/chat/DM/inbox → world/player/movement/map | useState< "loading" \| "ready" \| "unavailable" >("loading") |
| 573 | useState | `[droppingInventoryItemKey, setDroppingInventoryItemKey]` | resources/harvesting/inventory → session/network/startup | useState<string \| null>(null) |
| 587 | useState | `[progressionRecordingStatus, setProgressionRecordingStatus]` | combat/equipment/classes/progression → developer/diagnostics | useState<ProgressionRecorderStatus>(() => progressionRecorder.getStatus()) |
| 606 | useState | `[developerCapabilities, setDeveloperCapabilities]` | combat/equipment/classes/progression → developer/diagnostics → session/network/startup | useState<DeveloperCapability[]>(session.developerCapabilities) |
| 619 | useState | `[developerFlagDiagnosticsOpen, setDeveloperFlagDiagnosticsOpen]` | flags → developer/diagnostics | useState(false) |
| 622 | useState | `[combatDiagnosticsEnabled, setCombatDiagnosticsEnabled]` | combat/equipment/classes/progression → developer/diagnostics | useState(false) |
| 623 | useState | `[movementDiagnosticsEnabled, setMovementDiagnosticsEnabled]` | world/player/movement/map → developer/diagnostics | useState(false) |
| 630 | useState | `[mobSpawnerOpen, setMobSpawnerOpen]` | world/player/movement/map → developer/diagnostics | useState(false) |
| 631 | useState | `[mobSpawnArchetype, setMobSpawnArchetype]` | world/player/movement/map → developer/diagnostics | useState<MobArchetypeKey \| null>(null) |
| 639 | useState | `[queuedMapFlagBuild, setQueuedMapFlagBuild]` | flags → world/player/movement/map | useState<QueuedMapFlagBuild \| null>(null) |
| 640 | useState | `[flagBuildClock, setFlagBuildClock]` | flags → developer/diagnostics | useState(performance.now()) |
| 667 | useState | `[selectedProfilePlayerId, setSelectedProfilePlayerId]` | social/chat/DM/inbox → world/player/movement/map | useState<string \| null>(null) |
| 687 | useState | `[partyPlayerNames, setPartyPlayerNames]` | party → world/player/movement/map | useState<Readonly<Record<string, string>>>({}) |
| 689 | useState | `[travelInbox, setTravelInbox]` | travel → social/chat/DM/inbox | useState<TravelInboxEntry[]>([]) |
| 690 | useState | `[travelInboxServerTime, setTravelInboxServerTime]` | travel → social/chat/DM/inbox | useState(() => Date.now()) |
| 691 | useState | `[travelInboxServerOffsetMs, setTravelInboxServerOffsetMs]` | travel → social/chat/DM/inbox | useState(0) |
| 692 | useState | `[travelInboxOpen, setTravelInboxOpen]` | travel → social/chat/DM/inbox | useState(false) |
| 716 | useState | `[devProgressionOpen, setDevProgressionOpen]` | combat/equipment/classes/progression → developer/diagnostics | useState(false) |
| 717 | useState | `[devProgressionPendingType, setDevProgressionPendingType]` | combat/equipment/classes/progression → developer/diagnostics | useState<DevProgressionType \| null>(null) |
| 718 | useState | `[devSubclassPending, setDevSubclassPending]` | combat/equipment/classes/progression → developer/diagnostics | useState<SubclassId \| null>(null) |
| 719 | useState | `[devProgressionError, setDevProgressionError]` | combat/equipment/classes/progression → developer/diagnostics | useState<string \| null>(null) |
| 751 | useState | `[directMessageStore]` | social/chat/DM/inbox → world/player/movement/map | useState(() => new DirectMessageStore({ ownPlayerId: playerId })) |
| 765 | useState | `[chatStore]` | social/chat/DM/inbox → world/player/movement/map | useState(() => new ChatStore({ ownPlayerId: playerId })) |
| 748 | useRef | `kingdomMapRef` | settlements/cities/Kingdom → world/player/movement/map | useRef<KingdomMapPresenter \| null>(null) |
| 758 | useRef | `directMessageRecoveringRef` | social/chat/DM/inbox → session/network/startup | useRef(false) |
| 760 | useRef | `directMessageCombatSuppressionRef` | social/chat/DM/inbox → combat/equipment/classes/progression | useRef(false) |
| 761 | useRef | `directMessageSendRequestsRef` | social/chat/DM/inbox → world/player/movement/map | useRef(new Map<string, string>()) |
| 762 | useRef | `directMessageOpenRequestsRef` | social/chat/DM/inbox → world/player/movement/map | useRef(new Map<string, string>()) |
| 764 | useRef | `directMessageLastReadRequestRef` | social/chat/DM/inbox → world/player/movement/map | useRef(new Map<string, string>()) |
| 780 | useRef | `manorMovementTimelineRef` | manor → world/player/movement/map | useRef(new ManorMovementTimeline()) |
| 782 | useRef | `queuedMapFlagBuildRef` | flags → world/player/movement/map | useRef(new QueuedMapFlagBuildController()) |
| 785 | useRef | `relocationRevisionRef` | travel → world/player/movement/map | useRef(0) |
| 797 | useRef | `manorSessionRef` | manor → session/network/startup | useRef<ManorClientSession \| null>(null) |
| 880 | useRef | `mobSpawnArchetypeRef` | world/player/movement/map → developer/diagnostics | useRef<MobArchetypeKey \| null>(null) |
| 883 | useRef | `flagBuildMarkerRef` | flags → world/player/movement/map | useRef<maplibregl.Marker \| null>(null) |
| 885 | useRef | `flagPlacementValidationPopupRef` | flags → world/player/movement/map | useRef<maplibregl.Popup \| null>(null) |
| 897 | useRef | `renderStateRef` | manor → settlements/cities/Kingdom → flags → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map | useRef<RenderState>({ localPlayerId: playerId, players: [], flags: [], cities: [], manors: [], collectibles: [], droppedItems: [], resourceVision: nul |
| 721 | useEffect | `(inline)` | developer/diagnostics → session/network/startup | useEffect(() => { setDeveloperCapabilities(session.developerCapabilities); }, [session.developerCapabilities]) |
| 724 | useEffect | `(inline)` | flags → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useEffect(() => { if (devObserveEnabled) return; setDeveloperToolsOpen(false); setDeveloperFlagDiagnosticsOpen(false); setResourceVisionOverlayEnabled |
| 740 | useEffect | `(inline)` | flags → developer/diagnostics | useEffect(() => { setDeveloperFlagDiagnosticsOpen(false); }, [selectedFlagId]) |
| 920 | useEffect | `(inline)` | travel → world/player/movement/map | useEffect(() => { if (!populationPreparing) return; const timer = window.setTimeout(() => { setPopulationPreparing(false); setWarning( "Surroundings a |
| 930 | useEffect | `(inline)` | settlements/cities/Kingdom → social/chat/DM/inbox → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics → session/network/startup | useEffect(() => { if (!devObserveEnabled \|\| !geographyDiagnosticsEnabled \|\| !localPlayer) { setWorldProfile(null); setWorldProfileStatus("loading"); r |
| 1004 | useEffect | `(inline)` | party → social/chat/DM/inbox → world/player/movement/map → session/network/startup | useEffect(() => { if (connectionStatus !== "online" \|\| partyIdentityPlayerIds.length === 0) return; let cancelled = false; void Promise.all(partyIdent |
| 1035 | useEffect | `(inline)` | party → world/player/movement/map | useEffect(() => { const nextExpiry = partyOutgoingInvites .map((invite) => Date.parse(invite.expiresAt)) .filter((expiresAt) => expiresAt > partyInvit |
| 1062 | useEffect | `(inline)` | social/chat/DM/inbox → combat/equipment/classes/progression → world/player/movement/map | useEffect(() => { if (classSnapshot?.activeClassId !== "cleric") { if (abilityTargetSelection) setAbilityTargetSelection(null); return; } if (!ability |
| 1157 | useEffect | `(inline)` | world/player/movement/map → developer/diagnostics | useEffect(() => { gameplayLatencyTrace.configure(clientConfig.serverHttpBase, csrfToken); const onVisibility = (): void => { gameplayLatencyTrace.reco |
| 1166 | useEffect | `(inline)` | travel → flags → world/player/movement/map → developer/diagnostics | useEffect(() => { const previewTerrain = new FlagPlacementPreviewTerrain( clientConfig.serverHttpBase, setFlagPlacementTerrain, globalThis.fetch.bind( |
| 1612 | useEffect | `(inline)` | combat/equipment/classes/progression → developer/diagnostics | useEffect(() => { const sampleInterval = window.setInterval(() => { if (!perfRecorder.isRecording()) { return; } const result = perfRecorder.recordSam |
| 1651 | useEffect | `(inline)` | flags → world/player/movement/map | useEffect(() => { locationModeRef.current = locationMode; if (mapContainerRef.current) { mapContainerRef.current.inert = locationMode !== "world"; } c |
| 1674 | useEffect | `(inline)` | manor → session/network/startup | useEffect(() => { manorSessionRef.current = manorSession; }, [manorSession]) |
| 1874 | useLayoutEffect | `(inline)` | manor → resources/harvesting/inventory → world/player/movement/map → developer/diagnostics | useLayoutEffect(() => { if (locationMode !== "world") return; let animationFrameId: number \| null = null; let attempts = 0; const restoreVisibleWorld  |
| 3758 | useEffect | `(inline)` | settlements/cities/Kingdom → flags → world/player/movement/map → developer/diagnostics → session/network/startup | useEffect(() => { if (!mapContainerRef.current) { return; } if (!gameEnteredMilestoneRef.current) { gameEnteredMilestoneRef.current = true; perfMetric |
| 4273 | useEffect | `(inline)` | flags → world/player/movement/map | useEffect(() => { flagPlacementPreviewTerrainRef.current?.setPosition( localPlayer ? { lat: localPlayer.lat, lon: localPlayer.lon } : null ); }, [loca |
| 4279 | useEffect | `(inline)` | travel → flags → world/player/movement/map | useEffect(() => { flagBuildIntentRef.current?.updatePlayerState(localPlayer ? { moving: localPlayer.moving, movementRevision: localPlayer.movementRevi |
| 4293 | useEffect | `(inline)` | flags → combat/equipment/classes/progression | useEffect(() => { if (localCombatEntity && localCombatEntity.lifeState !== "alive") { flagBuildIntentRef.current?.cancel("invalidated"); } }, [localCo |
| 4299 | useEffect | `(inline)` | flags → resources/harvesting/inventory → world/player/movement/map | useEffect(() => { setWaterOverlayPlacementMode( mapRef.current, Boolean(flagBuild) \|\| Boolean(flagPlacementValidation) \|\| flagQuotePreparing \|\| flagPl |
| 4311 | useEffect | `(inline)` | world/player/movement/map → session/network/startup | useEffect(() => { return subscribeAppResume(document, window, () => { const recovery = clientRef.current?.recoverIfNeeded(); if (recovery === "reconne |
| 4322 | useEffect | `(inline)` | manor → settlements/cities/Kingdom → social/chat/DM/inbox → flags → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useEffect(() => { renderStateRef.current = { localPlayerId: playerId, players, flags, cities, manors, collectibles, droppedItems, resourceVision: devO |
| 4384 | useEffect | `(inline)` | resources/harvesting/inventory → session/network/startup | useEffect(() => { if (connectionStatus !== "online") { return; } const timeout = window.setTimeout(() => { clientRef.current?.requestNearbyCollectible |
| 4400 | useEffect | `(inline)` | settlements/cities/Kingdom → world/player/movement/map → session/network/startup | useEffect(() => { const generation = ++publicKingdomRequestRef.current; if (!selectedKingdomId) { setSelectedPublicKingdom(null); setPublicKingdomErro |
| 4430 | useEffect | `(inline)` | settlements/cities/Kingdom → flags → world/player/movement/map | useEffect(() => { kingdomMapRef.current?.update(kingdomState); setFlags((current) => synchronizeKingdomSeatPresentation(current, kingdomState)); }, [k |
| 4435 | useEffect | `(inline)` | settlements/cities/Kingdom → session/network/startup | useEffect(() => { if (connectionStatus !== "online") return; clientRef.current?.requestKingdomState(); const interval = window.setInterval(() => { cli |
| 4453 | useEffect | `(inline)` | settlements/cities/Kingdom → session/network/startup | useEffect(() => { if (selectedCityId && connectionStatus === "online") { setCityInfo((current) => current?.city.id === selectedCityId ? current : null |
| 4491 | useEffect | `(inline)` | resources/harvesting/inventory → world/player/movement/map | useEffect(() => { if (!droppedItemInteraction \|\| !localPlayer) { return; } const drop = droppedItems.find( (candidate) => candidate.dropId === dropped |
| 4525 | useEffect | `(inline)` | resources/harvesting/inventory → world/player/movement/map → session/network/startup | useEffect(() => { if (!harvestTask \|\| !selectedCollectible \|\| !localPlayer) { return; } const tickHarvest = (): void => { const nowMs = Date.now(); se |
| 4601 | useEffect | `(inline)` | resources/harvesting/inventory → combat/equipment/classes/progression | useEffect(() => { if (localCombatEntity && localCombatEntity.lifeState !== "alive") { cancelHarvestSelection(false); } }, [cancelHarvestSelection, loc |
| 4611 | useEffect | `(inline)` | flags → developer/diagnostics | useEffect(() => { if (!flagBuild) return; const interval = window.setInterval(() => setFlagBuildClock(performance.now()), 50); return () => window.cle |
| 4617 | useEffect | `(inline)` | world/player/movement/map → session/network/startup | useEffect(() => { if (!worldMapOpen \|\| connectionStatus !== "online") return; const interval = window.setInterval( () => clientRef.current?.requestWor |
| 4626 | useEffect | `(inline)` | flags → combat/equipment/classes/progression → world/player/movement/map | useEffect(() => { placementPreviewMarkerRef.current?.remove(); placementPreviewMarkerRef.current = null; const map = mapRef.current; if ( !map \|\| !loc |
| 4684 | useEffect | `(inline)` | flags → combat/equipment/classes/progression → world/player/movement/map | useEffect(() => { flagPlacementValidationPopupRef.current?.remove(); flagPlacementValidationPopupRef.current = null; const map = mapRef.current; if (  |
| 4724 | useEffect | `(inline)` | flags → combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useEffect(() => { flagBuildMarkerRef.current?.remove(); flagBuildMarkerRef.current = null; const map = mapRef.current; if (!map \|\| !flagBuild) return; |
| 4766 | useEffect | `(inline)` | flags → world/player/movement/map | useEffect(() => { if (!flagBuild \|\| !localPlayer) return; flagBuildMarkerRef.current?.setLngLat([localPlayer.lon, localPlayer.lat]); }, [flagBuild?.bu |
| 4771 | useEffect | `(inline)` | flags → combat/equipment/classes/progression | useEffect(() => { if (!flagBuild) return; const progress = flagBuildProgress(flagBuild.countdown, flagBuildClock); const markerElement = flagBuildMark |
| 4840 | useEffect | `(inline)` | travel → flags → world/player/movement/map → session/network/startup | useEffect(() => { if (!localPlayer \|\| !queuedMapFlagBuild) return; const observation = queuedMapFlagBuildRef.current.observe(localPlayer); if (observa |
| 4863 | useEffect | `(inline)` | flags → combat/equipment/classes/progression → world/player/movement/map → session/network/startup | useEffect(() => { if ( connectionStatus !== "online" \|\| locationMode !== "world" \|\| (localCombatEntity !== null && localCombatEntity.lifeState !== "al |
| 4972 | useEffect | `(inline)` | market → settlements/cities/Kingdom → social/chat/DM/inbox → flags → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics → session/network/startup | useEffect(() => { const onKeyDown = (event: KeyboardEvent): void => { if (event.key === "F1") { if (!devObserveEnabled) return; event.preventDefault() |
| 5639 | useEffect | `(inline)` | pets/expeditions → market → travel → settlements/cities/Kingdom → social/chat/DM/inbox → flags → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useEffect(() => { if (uiEnvironment.profile !== "phone") return; setInventoryOpen(mobileView === "equipment"); setCharacterOpen(mobileView === "charac |
| 7060 | useEffect | `(inline)` | combat/equipment/classes/progression → world/player/movement/map → session/network/startup | useEffect(() => { if (!enabled) return; const update = (): void => { const map = document.querySelector<HTMLElement>(".map-root"); const canvas = map? |
| 372 | useCallback | `checkRelease` | world/player/movement/map → session/network/startup | useCallback(async (): Promise<void> => { const result = await checkClientRelease( clientConfig.buildSha, clientConfig.serverHttpBase, window.location. |
| 803 | useCallback | `sendDirectMessageCandidate` | social/chat/DM/inbox → session/network/startup | useCallback((candidate: OptimisticDirectMessage): boolean => { if (candidate.conversationId === null \|\| directMessageRecoveringRef.current) return fal |
| 815 | useCallback | `requestDirectMessageOpen` | social/chat/DM/inbox → world/player/movement/map | useCallback((targetPlayerId: string): boolean => { const requestId = clientRef.current?.openDirectMessage(targetPlayerId); if (!requestId) return fals |
| 822 | useCallback | `openDirectMessagePeer` | social/chat/DM/inbox → world/player/movement/map | useCallback(( targetPlayerId: string, displayName: string, online?: boolean ): void => { if (targetPlayerId === playerId) return; const worldPlayer =  |
| 841 | useCallback | `openChatSender` | social/chat/DM/inbox → world/player/movement/map | useCallback(( senderPlayerId: string, displayName: string, anchorRect: PlayerActionsTarget["anchorRect"] ): void => { setPlayerActionsTarget({ playerI |
| 848 | useCallback | `handleRelationshipMutated` | social/chat/DM/inbox → world/player/movement/map | useCallback( (targetPlayerId: string, action: SocialAction): void => { if (action === "block" \|\| action === "unblock") { directMessageStore.setBlocked |
| 1256 | useCallback | `cancelQueuedMapFlagBuild` | flags → world/player/movement/map | useCallback((announce = false): boolean => { if (!queuedMapFlagBuildRef.current.cancel()) return false; setQueuedMapFlagBuild(null); if (announce) set |
| 1263 | useCallback | `requestLocalMovement` | travel → flags → world/player/movement/map → developer/diagnostics → session/network/startup | useCallback((lat: number, lon: number): string \| null => { cancelQueuedMapFlagBuild(true); const target = { lat, lon }; const boundTravelRequestId = p |
| 1329 | useCallback | `queueMapFlagBuild` | travel → flags → world/player/movement/map → developer/diagnostics → session/network/startup | useCallback((intent: { requested: { lat: number; lon: number }; target: { lat: number; lon: number }; outside: boolean; }): void => { const player = l |
| 1356 | useCallback | `cancelHarvestSelection` | resources/harvesting/inventory → world/player/movement/map → session/network/startup | useCallback((stopMovement = true): void => { const activeTask = harvestTaskRef.current; const activePhase = activeTask?.phase; if ( stopMovement && (a |
| 1388 | useCallback | `clearDroppedItemInteraction` | resources/harvesting/inventory → world/player/movement/map → session/network/startup | useCallback( (options: { stopMovement?: boolean; clearSelection?: boolean; releaseRequestGate?: boolean; expectedDropId?: string; } = {}): boolean =>  |
| 1427 | useCallback | `attemptDroppedItemPickup` | resources/harvesting/inventory → world/player/movement/map → session/network/startup | useCallback( (dropId: string, intent: DroppedItemPickupIntent): boolean => { const interaction = droppedItemInteractionRef.current; if ( interaction?. |
| 1457 | useCallback | `confirmDroppedItemPickup` | resources/harvesting/inventory → world/player/movement/map | useCallback( (intent: DroppedItemPickupIntent): void => { const dropId = selectedDroppedItemIdRef.current; const drop = droppedItems.find((candidate)  |
| 1482 | useCallback | `selectDroppedItemForPickup` | social/chat/DM/inbox → flags → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map → session/network/startup | useCallback( (drop: DroppedItemSnapshot): void => { cancelHarvestSelection(); if (selectedDroppedItemIdRef.current === drop.dropId) { return; } clearD |
| 1507 | useCallback | `finishProgressionRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback( (recording: ProgressionRecording): string => { const jsonFilename = progressionRecordingFilename(recording.startedAt, "json"); const csvF |
| 1521 | useCallback | `startProgressionRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback((): string => { if (progressionRecorder.isRecording()) return "Progression recording already running."; if (!progression) return "Progress |
| 1530 | useCallback | `stopProgressionRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback((): string => { if (!progression) return "Progression snapshot is not ready."; const recording = progressionRecorder.stop({ progression, e |
| 1540 | useCallback | `resetProgressionRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback((): string => { progressionRecorder.reset(); setLastProgressionFilenames(null); setProgressionRecordingStatus(progressionRecorder.getStatu |
| 1559 | useCallback | `startPerformanceRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback((): string => { if (perfRecorder.isRecording()) { return "Performance recording already running."; } perfMetrics.resetRateSample("recorder |
| 1573 | useCallback | `stopPerformanceRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback((): string => { const recording = perfRecorder.stopRecording("manual"); if (!recording) { setRecordingStatus(perfRecorder.getStatus()); re |
| 1583 | useCallback | `resetPerformanceRecording` | combat/equipment/classes/progression → developer/diagnostics | useCallback((): string => { perfRecorder.resetRecording(); setLastRecordingFilename(null); setRecordingStatus(perfRecorder.getStatus()); setRecordingM |
| 1723 | useCallback | `finishProgrammaticCameraMove` | flags → world/player/movement/map | useCallback((generation: number): void => { if (!cameraActionGenerationRef.current.complete(generation)) { return; } clearProgrammaticCameraEndTimer() |
| 1760 | useCallback | `centerCamera` | world/player/movement/map → developer/diagnostics | useCallback( ( trigger: CameraCenterTrigger, position: { lat: number; lon: number }, durationMs: number, moveTimeoutMs: number ): void => { if (!shoul |
| 1795 | useCallback | `receiveInventorySnapshot` | resources/harvesting/inventory → world/player/movement/map | useCallback( (snapshot: unknown): void => { setInventory(normalizeInventorySnapshot(snapshot, playerId)); setInventorySnapshotReceived(true); }, [play |
| 1803 | useCallback | `refreshCombatUi` | combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useCallback((): void => { perfMetrics.setCombatEntityCount(combatStoreRef.current.metrics().entityCount); const nextLocal = combatStoreRef.current.get |
| 1827 | useCallback | `snapRespawnedPlayers` | combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useCallback((state: CombatStateBatch): void => { for (const event of state.events) { if (event.type !== "RESPAWNED" \|\| !event.targetEntityId) { contin |
| 1845 | useCallback | `requestWorldResync` | combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useCallback((reason: string): void => { const now = performance.now(); if (now - lastWorldResyncRequestAtRef.current < 1_000) { recordMovementTrace({  |
| 1905 | useCallback | `handleDirectMessageFrame` | social/chat/DM/inbox → world/player/movement/map → session/network/startup | useCallback((frame: DirectMessageServerMessage): void => { if (frame.type === "DM_ERROR") { const clientMessageId = frame.requestId ? directMessageSen |
| 2012 | useCallback | `handleMessage` | pets/expeditions → market → travel → social/chat/DM/inbox → resources/harvesting/inventory → combat/equipment/classes/progression → world/player/movement/map | useCallback( (message: ServerMessage) => { if (isDirectMessageServerMessage(message)) { handleDirectMessageFrame(message); return; } if ( message.type |
| 4793 | useCallback | `requestBuildFlag` | flags → world/player/movement/map → developer/diagnostics | useCallback((): void => { const pressedAt = performance.now(); const preview = flagPlacementPreviewTerrainRef.current; const quote = preview?.currentQ |
| 4873 | useCallback | `runTraceStationaryQuote` | flags → developer/diagnostics | useCallback(async (): Promise<void> => { const preview = flagPlacementPreviewTerrainRef.current; if (!preview) throw new Error("Flag preparation is un |
| 4881 | useCallback | `runTraceMoveStopQuote` | flags → world/player/movement/map → developer/diagnostics → session/network/startup | useCallback(async (): Promise<void> => { const player = localPlayerRef.current; const client = clientRef.current; if (!player \|\| !client) throw new Er |
| 4905 | useCallback | `runTraceMoveStopBuild` | flags → world/player/movement/map → developer/diagnostics | useCallback(async (): Promise<void> => { await runTraceMoveStopQuote(); requestBuildFlag(); }, [requestBuildFlag, runTraceMoveStopQuote]) |
| 4910 | useCallback | `runTraceReliability` | combat/equipment/classes/progression → world/player/movement/map → developer/diagnostics | useCallback(async (): Promise<void> => { for (let index = 0; index < 20; index += 1) { gameplayLatencyTrace.record("ui", "reliability_cycle_started",  |
| 4918 | useCallback | `requestCityFoundingPreview` | settlements/cities/Kingdom → flags | useCallback((flagId: string): void => { if (foundingCity) return; setFoundingCity(true); setWarning(null); clientRef.current?.previewCityFounding(flag |
| 4925 | useCallback | `confirmFoundCity` | settlements/cities/Kingdom → flags | useCallback((): void => { if (!cityFoundingPreview?.eligible \|\| foundingCity) return; setFoundingCity(true); setWarning(null); clientRef.current?.foun |
| 4932 | useCallback | `requestCityFlagConversion` | settlements/cities/Kingdom → flags | useCallback((flagId: string): void => { if (cityActionBusy) return; setCityActionBusy(true); setWarning(null); clientRef.current?.convertCityFlag(flag |

Routing order is: parse once, validate once, primary route once, apply primary state, run named
observers, and render published snapshots. Controllers cannot expose generic setter bags. The map
runtime exclusively owns MapLibre/Pixi objects, markers, popups, map listeners, camera generation,
overlay gates, and teardown; domains exchange typed intents and presentation snapshots.

## Wave 3B implementation status

Hooks own pet, party, manor, chat, direct-message, market, world, settlement, combat/equipment,
harvesting, flags, travel, developer, and session frame slices. The map runtime owns construction
and named listener registration/removal helpers. App fell from 7,465 to 5,627 physical lines and
from 163 to 111 `useState` calls while preserving the accepted UI.

The server-frame composition endpoint is complete: App wires typed domain handlers and ordered
observers but contains no broad `ServerMessage` switch, message-type case body, raw parse/send
boundary, or domain frame mutation body. Remaining App size is UI/map presentation composition,
not a renamed replacement frame owner. Architecture fixtures prevent protocol or frame ownership
from collapsing back into App or another composition host.
