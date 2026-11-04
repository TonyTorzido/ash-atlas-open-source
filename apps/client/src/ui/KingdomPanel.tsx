import {
  KINGDOM_FOUNDING_BASE_REQUIREMENTS,
  KINGDOM_FOUNDING_MIN_PLAYER_LEVEL,
  KINGDOM_FOUNDING_CHANNEL_DURATION_MS,
  KINGDOM_BRICK_FURNACE_MAX_LEVEL,
  KINGDOM_BRICK_TAX_PERCENT,
  KINGDOM_REVOLT_BOOST_CAP,
  KINGDOM_REVOLT_BOOST_PER_LEADER_DEATH,
  RESOURCE_TYPES,
  kingdomBrickDepositSplit,
  kingdomBrickFurnaceLevel,
  KINGDOM_COMMAND_BOARD_MAX_LEVEL,
  WAR_OUTPOST_MATERIALS,
  WAR_TOWER_GOLD_COST,
  WAR_TOWER_MATERIALS,
  kingdomWarStructureLabel,
  kingdomCommandBoardLevel,
  type KingdomWarMaterial,
  type KingdomWarStructureKind,
  unicodeLength,
  type KingdomCotSnapshot,
  type KingdomDecorationDefinition,
  type KingdomDecorationSnapshot,
  type KingdomDonationEntry,
  type KingdomInvitationSnapshot,
  type KingdomMemberSnapshot,
  type KingdomPermission,
  type KingdomPublicSnapshot,
  type KingdomRevoltState,
  type KingdomStateSnapshot,
  type KingdomCastleRubbleSnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  flagBuildProgress,
  flagBuildRemainingTimeLabel,
  type FlagBuildCountdown
} from "../flags/flagBuildCountdown.js";

import { ConfirmDialog } from "./ConfirmDialog.js";
import { KINGDOM_DOWNGRADE_ACTION_LABEL, downgradeConfirmationMessage } from "../kingdom/kingdomDowngrade.js";
import { DestinationShell } from "./DestinationShell.js";
import { GameAppTabs } from "./GameAppShell.js";
import { MaterialChips } from "./MaterialRequirements.js";
import { RealmAppTabs, type RealmAppSection } from "./RealmAppTabs.js";

import {
  KingdomApiClient,
  KingdomApiError,
  type KingdomDecorationActionRequest,
  type KingdomFoundingQuoteResult,
  type KingdomMemberAction,
  type KingdomMutationResult
} from "../kingdom/kingdomClient.js";
import {
  KINGDOM_PANEL_TABS,
  KINGDOM_PANEL_TAB_LABELS,
  formatDurationSeconds,
  formatKingdomRole,
  hasPermission,
  kingdomErrorMessage,
  mayModerateMember,
  type KingdomPanelTab
} from "../kingdom/kingdomPanelModel.js";
import "./KingdomPanel.css";
import { OrganizationWarsSection } from "./OrganizationWarsSection.js";
import { KingdomPerksSection, kingdomPerkChoiceMessage } from "./KingdomPerksSection.js";

export type KingdomFoundingDraft = {
  displayName: string;
  displayColor: string;
};

export type KingdomPanelProps = {
  open: boolean;
  ownPlayerId: string;
  serverHttpBase: string;
  csrfToken: string;
  connected: boolean;
  layout: "desktop" | "phone";
  foundingPosition: { lat: number; lon: number } | null;
  snapshot: KingdomStateSnapshot | null;
  selectedKingdomId?: string | null;
  publicKingdom?: KingdomPublicSnapshot | null;
  publicKingdomError?: string | null;
  onSnapshot(snapshot: KingdomStateSnapshot): void;
  onRequestRefresh?: (() => void) | undefined;
  onSendChat?: ((content: string, requestId: string) => boolean | void | Promise<boolean | void>) | undefined;
  onBeginCotPlacement?: ((rotation: number) => void) | undefined;
  onPackCot?: ((cot: KingdomCotSnapshot) => void) | undefined;
  onBeginDecorationPlacement?: ((input: {
    definition: KingdomDecorationDefinition;
    kingdomOwned: boolean;
    rotation: number;
  }) => void) | undefined;
  onBeginDecorationMove?: ((decoration: KingdomDecorationSnapshot) => void) | undefined;
  onOpenPlayer?: ((playerId: string) => void) | undefined;
  onVisitKingdomSeat?: ((seatId: string) => void) | undefined;
  onVisitKingdomFlag?: ((flagId: string) => void) | undefined;
  onViewKingdomFlag?: ((flagId: string) => void) | undefined;
  onMessagePlayer?: ((playerId: string, displayName: string) => void) | undefined;
  onFoundingBuildChanged?: ((build: {
    countdown: FlagBuildCountdown;
    position: { lat: number; lon: number };
  } | null) => void) | undefined;
  onFoundingBuildCancelled?: ((message: string) => void) | undefined;
  onOpenRealmSection?: ((section: RealmAppSection) => void) | undefined;
  onClose(): void;
};

type MutationRunner = (
  label: string,
  request: () => Promise<KingdomMutationResult>,
  successMessage?: string
) => Promise<boolean>;

export function KingdomPanel({
  open,
  ownPlayerId,
  serverHttpBase,
  csrfToken,
  connected,
  layout,
  foundingPosition,
  snapshot,
  selectedKingdomId,
  publicKingdom = null,
  publicKingdomError = null,
  onSnapshot,
  onRequestRefresh,
  onBeginCotPlacement,
  onPackCot,
  onBeginDecorationPlacement,
  onBeginDecorationMove,
  onOpenPlayer,
  onVisitKingdomSeat,
  onMessagePlayer,
  onFoundingBuildChanged,
  onFoundingBuildCancelled,
  onOpenRealmSection,
  onClose
}: KingdomPanelProps): React.JSX.Element | null {
  const api = useMemo(
    () => new KingdomApiClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [activeTab, setActiveTab] = useState<KingdomPanelTab>("overview");
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    run(): Promise<boolean>;
  } | null>(null);
  const [foundingQuote, setFoundingQuote] = useState<KingdomFoundingQuoteResult | null>(null);
  const [foundingQuoteStaleReason, setFoundingQuoteStaleReason] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const loadedForOpenRef = useRef(false);
  const foundingPositionKey = foundingPosition
    ? `${foundingPosition.lat}:${foundingPosition.lon}`
    : "unavailable";
  const foundingPositionKeyRef = useRef(foundingPositionKey);

  const explicitPublicSelection = Boolean(
    selectedKingdomId && selectedKingdomId !== snapshot?.kingdom?.id
  );
  const inferredPublicSelection = Boolean(
    publicKingdom && publicKingdom.id !== snapshot?.kingdom?.id
  );
  const publicOnly = explicitPublicSelection || inferredPublicSelection;
  const activeMembership = !publicOnly && snapshot?.membership?.status === "active"
    ? snapshot.membership
    : null;
  const kingdom = publicOnly ? publicKingdom : snapshot?.kingdom ?? publicKingdom;
  const permissions = publicOnly ? [] : snapshot?.permissions ?? [];

  const clearFoundingQuote = (): void => {
    setFoundingQuote(null);
    setFoundingQuoteStaleReason(null);
  };

  const invalidateFoundingQuote = (reason: string): void => {
    setFoundingQuote(null);
    setFoundingQuoteStaleReason(reason);
  };

  useEffect(() => {
    if (!open) {
      loadedForOpenRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      return;
    }
    if (snapshot || loadedForOpenRef.current) return;
    loadedForOpenRef.current = true;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    void api.getState().then((next) => {
      if (generation === loadGenerationRef.current) onSnapshot(next);
    }).catch((reason: unknown) => {
      if (generation === loadGenerationRef.current) setError(displayError(reason));
    }).finally(() => {
      if (generation === loadGenerationRef.current) setLoading(false);
    });
  }, [api, onSnapshot, open, snapshot]);

  useEffect(() => {
    const previous = foundingPositionKeyRef.current;
    foundingPositionKeyRef.current = foundingPositionKey;
    if (previous === foundingPositionKey) return;
    mutationGenerationRef.current += 1;
    setBusyAction(null);
    if (foundingQuote) {
      setFoundingQuote(null);
      setFoundingQuoteStaleReason(
        "You moved, so any active Kingdom build was canceled. Check the location again before founding."
      );
    }
    setError(null);
    setNotice(null);
  }, [foundingPositionKey, foundingQuote]);

  useEffect(() => {
    if (!activeMembership && !["overview", "members"].includes(activeTab)) {
      setActiveTab("overview");
    }
  }, [activeMembership, activeTab]);

  const runMutation: MutationRunner = async (label, request, successMessage) => {
    if (busyAction) return false;
    const generation = ++mutationGenerationRef.current;
    setBusyAction(label);
    setError(null);
    setNotice(null);
    try {
      const result = await request();
      if (generation !== mutationGenerationRef.current) return false;
      if (result.state) onSnapshot(result.state);
      if (result.stateRefreshRequired) {
        onRequestRefresh?.();
        setNotice("Action completed. Refreshing Kingdom state.");
      } else {
        setNotice(result.message ?? successMessage ?? (result.replayed ? "Already completed." : "Kingdom updated."));
      }
      return true;
    } catch (reason) {
      if (generation === mutationGenerationRef.current) setError(displayError(reason));
      return false;
    } finally {
      if (generation === mutationGenerationRef.current) setBusyAction(null);
    }
  };

  const requestFoundingQuote = async (draft: KingdomFoundingDraft): Promise<boolean> => {
    if (busyAction) return false;
    const generation = ++mutationGenerationRef.current;
    setBusyAction("founding-quote");
    setError(null);
    setNotice(null);
    try {
      const quote = await api.getFoundingQuote({
        displayName: draft.displayName,
        displayColor: draft.displayColor
      });
      if (generation !== mutationGenerationRef.current) return false;
      setFoundingQuote(quote);
      setFoundingQuoteStaleReason(null);
      return true;
    } catch (reason) {
      if (generation === mutationGenerationRef.current) {
        clearFoundingQuote();
        setError(displayError(reason));
      }
      return false;
    } finally {
      if (generation === mutationGenerationRef.current) setBusyAction(null);
    }
  };

  if (!open) return null;

  const memberOnly = activeMembership === null;
  const title = kingdom?.displayName ?? "Kingdom";
  const subtitle = activeMembership
    ? `${formatKingdomRole(activeMembership.role)} - Level ${kingdom?.level ?? 1}`
    : publicOnly
      ? kingdom
        ? `Public Kingdom - Level ${kingdom.level}`
        : publicKingdomError ?? "Loading public Kingdom..."
      : "Found a Kingdom or respond to an invitation";
  const closeApp = (): void => {
    clearFoundingQuote();
    onClose();
  };
  return (
    <>
    <DestinationShell
      open={open}
      title={title}
      subtitle={subtitle}
      closeLabel="Close Kingdom App"
      className="kingdom-app-panel"
      layout={layout}
      phoneBackLabel="Back to Game Menu"
      initialFocus="container"
      onClose={closeApp}
    >
      {onOpenRealmSection ? <RealmAppTabs activeSection="kingdom" onChange={onOpenRealmSection} /> : null}
      <div className="kingdom-app" aria-busy={loading || busyAction !== null}>
      <GameAppTabs
        variant={onOpenRealmSection ? "subtabs" : "housed"}
        scrollable={layout === "phone"}
        ariaLabel="Kingdom sections"
        activeTab={activeTab}
        onChange={(tab) => setActiveTab(tab as KingdomPanelTab)}
        tabs={KINGDOM_PANEL_TABS.map((tab) => ({
          id: tab,
          label: KINGDOM_PANEL_TAB_LABELS[tab],
          disabled: publicOnly ? tab !== "overview" : memberOnly && !["overview", "members"].includes(tab)
        }))}
      />

      {error ? <div className="kingdom-alert error" role="alert">{error}</div> : null}
      {publicOnly && publicKingdomError ? (
        <div className="kingdom-alert error" role="alert">{publicKingdomError}</div>
      ) : null}
      {notice ? <div className="kingdom-alert success" role="status">{notice}</div> : null}
      {loading && !snapshot ? <div className="kingdom-empty">Loading Kingdom state...</div> : null}

      <section className="kingdom-tab-content" role="tabpanel">
        {activeTab === "overview" && snapshot?.castleRubble && activeMembership ? (
          <CastleRubbleCard
            rubble={snapshot.castleRubble}
            isLeader={activeMembership.role === "leader"}
            busy={busyAction !== null}
            connected={connected}
            onRebuild={() => {
              setConfirmation({
                title: "Rebuild the Castle?",
                message: `The Castle returns at full health where it stood, and the kingdom's perks and building resume. Cost: ${rubbleCostText(snapshot.castleRubble!)}; each material comes from the treasury when it holds enough, otherwise from your pack.`,
                confirmLabel: "Rebuild Castle",
                run: () => runMutation("rebuild-castle", () => api.rebuildCastle(), "The Castle stands again.")
              });
            }}
            onDisband={() => {
              const name = kingdom?.displayName ?? "this Kingdom";
              setConfirmation({
                title: `Disband ${name}?`,
                message: "Every membership ends and every Kingdom Flag breaks in a territory collapse. This cannot be undone.",
                confirmLabel: "Disband Kingdom",
                run: () => runMutation("dissolve", () => api.dissolve(), "Kingdom disbanded.")
              });
            }}
          />
        ) : null}
        {activeTab === "overview" ? (
          <OverviewSection
            snapshot={snapshot}
            kingdom={kingdom}
            membership={activeMembership}
            publicOnly={publicOnly}
            permissions={permissions}
            foundingQuote={foundingQuote}
            foundingQuoteStaleReason={foundingQuoteStaleReason}
            busyAction={busyAction}
            foundingPosition={foundingPosition}
            onFoundingBuildChanged={onFoundingBuildChanged}
            onFoundingBuildCancelled={onFoundingBuildCancelled}
            onFoundingDraftChanged={() => {
              if (foundingQuote) {
                invalidateFoundingQuote(
                  "Founding details changed, so any active Kingdom build was canceled. Check the location again."
                );
              }
              setError(null);
              setNotice(null);
            }}
            onCancelFoundingQuote={clearFoundingQuote}
            onRequestQuote={requestFoundingQuote}
            onFound={async (draft) => {
              const sourceFlagId = foundingQuote?.sourceFlag?.id;
              if (!sourceFlagId) return false;
              const completed = await runMutation(
                "found",
                () => api.found({
                  sourceFlagId,
                  displayName: draft.displayName,
                  displayColor: draft.displayColor
                }),
                "Kingdom founding started at your current position."
              );
              clearFoundingQuote();
              return completed;
            }}
            onLeave={() => runMutation("leave", () => api.leave(), "You left the Kingdom.")}
            onDissolve={() => {
              const name = kingdom?.displayName ?? "this Kingdom";
              setConfirmation({
                title: `Dissolve ${name}?`,
                message: "Every membership and pending invitation will end, and the Castle, cots, and decorations will be archived.",
                confirmLabel: "Dissolve Kingdom",
                run: () => runMutation("dissolve", () => api.dissolve(), "Kingdom archived.")
              });
              return Promise.resolve(false);
            }}
            onVisitKingdomSeat={onVisitKingdomSeat}
          />
        ) : null}
        {activeTab === "members" && activeMembership && snapshot?.revolt ? (
          <RevoltSection
            state={snapshot.revolt}
            isLeader={activeMembership.role === "leader"}
            busy={busyAction !== null}
            connected={connected}
            onDeadline={() => onRequestRefresh?.()}
            onStart={() => {
              setConfirmation({
                title: "Start a revolt?",
                message: "Your yes vote is cast with it. The vote lasts up to 4 days and passes as soon as more than 55% of the members active in the last 6 days vote yes. A passed revolt removes the leader and starts 2 days of anarchy.",
                confirmLabel: "Start Revolt",
                run: () => runMutation("revolt-start", () => api.startRevolt(), "Revolt vote started.")
              });
              return Promise.resolve(false);
            }}
            onVote={(revoltId, support) => runMutation(
              `revolt-vote-${support ? "yes" : "no"}`,
              () => api.voteRevolt(revoltId, support),
              support ? "You voted for the revolt." : "You voted against the revolt."
            )}
          />
        ) : null}
        {activeTab === "members" ? (
          <MembersSection
            snapshot={snapshot}
            ownPlayerId={ownPlayerId}
            membership={activeMembership}
            permissions={permissions}
            busy={busyAction !== null}
            onOpenPlayer={onOpenPlayer}
            onMessagePlayer={onMessagePlayer}
            onInvite={(playerId) => runMutation("invite", () => api.invite(playerId), "Invitation sent.")}
            onInvitation={(invitation, response) => runMutation(
              `invitation-${response}`,
              () => api.respondToInvitation({ invitationId: invitation.id, response }),
              response === "accept" ? "Invitation accepted." : "Invitation declined."
            )}
            onCancelInvitation={(invitation) => runMutation(
              "invitation-cancel",
              () => api.cancelInvitation(invitation.id),
              "Invitation cancelled."
            )}
            onMemberAction={(member, action) => {
              if (["remove", "ban", "transfer_leadership"].includes(action)) {
                const copy = action === "transfer_leadership"
                  ? { title: `Transfer leadership to ${member.displayName}?`, message: "You will become an officer and this player will gain full leader authority.", label: "Transfer Leadership" }
                  : action === "ban"
                    ? { title: `Ban ${member.displayName}?`, message: "They will be removed, their personal Kingdom objects will be packed, and they cannot rejoin until unbanned.", label: "Ban Player" }
                    : { title: `Remove ${member.displayName}?`, message: "They will leave the roster and their personal Kingdom objects will be packed.", label: "Remove Player" };
                setConfirmation({
                  title: copy.title,
                  message: copy.message,
                  confirmLabel: copy.label,
                  run: () => runMutation(`member-${action}`, () => api.memberAction(member.playerId, action))
                });
                return Promise.resolve(false);
              }
              return runMutation(`member-${action}`, () => api.memberAction(member.playerId, action));
            }}
            onMute={(member, action, mutedUntil) => runMutation(
              "member-mute",
              () => api.muteMember(member.playerId, action, mutedUntil),
              action === "mute" ? "Member muted." : "Member unmuted."
            )}
          />
        ) : null}
        {activeTab === "treasury" && snapshot ? (
          <TreasurySection
            snapshot={snapshot}
            busy={busyAction !== null}
            connected={connected}
            onDonate={(resourceType, variant, quantity) => runMutation(
              "donate",
              () => api.donate({ resourceType, variant, quantity }),
              "Donation deposited."
            )}
            onDepositBricks={(quantity) => runMutation(
              "deposit-bricks",
              () => api.depositBricks(quantity),
              "Bricks deposited."
            )}
            onUpgradeFurnace={(targetLevel) => runMutation(
              "upgrade-furnace",
              () => api.upgradeBrickFurnace(targetLevel),
              targetLevel === 1 ? "Brick Furnace built." : `Brick Furnace upgraded to level ${targetLevel}.`
            )}
            onDowngradeFurnace={(fromLevel) => {
              setConfirmation({
                title: `Downgrade the Brick Furnace to level ${fromLevel - 1}?`,
                message: downgradeConfirmationMessage("brick_furnace", fromLevel),
                confirmLabel: "Downgrade",
                run: () => runMutation(
                  "downgrade-furnace",
                  () => api.downgradeStructure({ structure: "brick_furnace", fromLevel }),
                  `Brick Furnace downgraded to level ${fromLevel - 1}.`
                )
              });
              return Promise.resolve(false);
            }}
            onBuyFurnacePackage={(furnaceLevel) => runMutation(
              "furnace-package",
              () => api.buyBrickFurnacePackage(furnaceLevel),
              "Brick package added to the treasury."
            )}
          />
        ) : null}
        {activeTab === "progression" && snapshot ? (
          <ProgressionSection snapshot={snapshot} />
        ) : null}
        {activeTab === "perks" && snapshot ? (
          <KingdomPerksSection
            snapshot={snapshot}
            connected={connected}
            busy={busyAction !== null}
            onChoose={(request) => {
              setConfirmation({
                title: request.currentPerk
                  ? `Change to ${request.perk.displayName}?`
                  : `Choose ${request.perk.displayName}?`,
                message: kingdomPerkChoiceMessage(request),
                confirmLabel: request.currentPerk ? "Change Perk" : "Choose Perk",
                run: () => runMutation(
                  "perk-choose",
                  () => api.chooseKingdomPerk(request.perk.id, request.currentPerk?.id ?? null),
                  `${request.perk.displayName} chosen.`
                )
              });
            }}
            onActivate={(perk) => {
              setConfirmation({
                title: `Activate ${perk.displayName}?`,
                message: "Every member gets the buff for 24 hours. The next activation is possible 24 hours from now.",
                confirmLabel: "Activate",
                run: () => runMutation(
                  "perk-activate",
                  () => api.activateKingdomPerk(perk.id),
                  `${perk.displayName} is active for 24 hours.`
                )
              });
            }}
          />
        ) : null}
        {activeTab === "objects" && snapshot ? (
          <ObjectsSection
            snapshot={snapshot}
            ownPlayerId={ownPlayerId}
            busy={busyAction !== null}
            permissions={permissions}
            onPlaceCot={(rotation) => {
              if (onBeginCotPlacement) {
                onBeginCotPlacement(rotation);
                setNotice("Cot placement mode started. The server will validate the final position.");
                return Promise.resolve(true);
              }
              return runMutation("cot", () => api.placeCot(rotation), "Cot placed.");
            }}
            onCotAction={(cot, action) => {
              if (action === "pack" && onPackCot) {
                onPackCot(cot);
                return Promise.resolve(true);
              }
              return runMutation(
                `cot-${action}`,
                () => api.cotAction({ cotId: cot.id, action, rotation: cot.rotation }),
                action === "pack" ? "Cot packed." : "Cot moved."
              );
            }}
            onPlaceDecoration={(definition, kingdomOwned, rotation) => {
              if (onBeginDecorationPlacement) {
                onBeginDecorationPlacement({ definition, kingdomOwned, rotation });
                setNotice("Decoration placement mode started. The server will validate the final position.");
                return Promise.resolve(true);
              }
              return runMutation(
                "decoration-place",
                () => api.placeDecoration({ typeId: definition.typeId, kingdomOwned, rotation }),
                "Decoration placed."
              );
            }}
            onDecorationAction={(decoration, action) => {
              if (action.action === "move" && onBeginDecorationMove) {
                onBeginDecorationMove(decoration);
                setNotice("Move mode started. The server will validate the final position.");
                return Promise.resolve(true);
              }
              return runMutation(
                `decoration-${action.action}`,
                () => api.decorationAction(action),
                action.action === "remove" ? "Decoration removed." : "Decoration moved."
              );
            }}
          />
        ) : null}
        {activeTab === "wars" && snapshot ? (
          <div className="kingdom-stack">
            <CommandBoardSection
              snapshot={snapshot}
              busy={busyAction !== null}
              connected={connected}
              onUpgrade={(targetLevel) => runMutation(
                "upgrade-command-board",
                () => api.upgradeCommandBoard(targetLevel),
                targetLevel === 1 ? "Command Board built." : `Command Board upgraded to level ${targetLevel}.`
              )}
              onDowngrade={(fromLevel) => {
                setConfirmation({
                  title: `Downgrade the Command Board to level ${fromLevel - 1}?`,
                  message: downgradeConfirmationMessage("command_board", fromLevel),
                  confirmLabel: "Downgrade",
                  run: () => runMutation(
                    "downgrade-command-board",
                    () => api.downgradeStructure({ structure: "command_board", fromLevel }),
                    `Command Board downgraded to level ${fromLevel - 1}.`
                  )
                });
                return Promise.resolve(false);
              }}
              onPlace={(kind) => runMutation(
                `place-${kind}`,
                () => api.placeWarStructure(kind),
                `${kingdomWarStructureLabel(kind)} raised.`
              )}
            />
            <OrganizationWarsSection side="kingdom" serverHttpBase={serverHttpBase} csrfToken={csrfToken} />
          </div>
        ) : null}
        {activeTab === "activity" && snapshot ? <ActivitySection snapshot={snapshot} /> : null}
      </section>
      </div>
    </DestinationShell>
    {confirmation ? (
      <ConfirmDialog
        title={confirmation.title}
        message={confirmation.message}
        confirmLabel={confirmation.confirmLabel}
        busy={busyAction !== null}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          const pending = confirmation;
          void pending.run().then((completed) => { if (completed) setConfirmation(null); });
        }}
      />
    ) : null}
    </>
  );
}

type OverviewProps = {
  snapshot: KingdomStateSnapshot | null;
  kingdom: KingdomPublicSnapshot | null;
  membership: KingdomMemberSnapshot | null;
  publicOnly: boolean;
  permissions: readonly KingdomPermission[];
  foundingQuote: KingdomFoundingQuoteResult | null;
  foundingQuoteStaleReason: string | null;
  busyAction: string | null;
  foundingPosition: { lat: number; lon: number } | null;
  onFoundingBuildChanged?: KingdomPanelProps["onFoundingBuildChanged"];
  onFoundingBuildCancelled?: KingdomPanelProps["onFoundingBuildCancelled"];
  onFoundingDraftChanged(): void;
  onCancelFoundingQuote(): void;
  onRequestQuote(draft: KingdomFoundingDraft): Promise<boolean>;
  onFound(draft: KingdomFoundingDraft): Promise<boolean>;
  onLeave(): Promise<boolean>;
  onDissolve(): Promise<boolean>;
  onVisitKingdomSeat?: ((seatId: string) => void) | undefined;
};

function OverviewSection(props: OverviewProps): React.JSX.Element {
  if (props.publicOnly) {
    return props.kingdom
      ? <PublicKingdomOverview kingdom={props.kingdom} onVisitKingdomSeat={props.onVisitKingdomSeat} />
      : <div className="kingdom-empty">Loading public Kingdom...</div>;
  }
  if (!props.membership) {
    return (
      <>
        {props.kingdom ? <PublicKingdomOverview kingdom={props.kingdom} onVisitKingdomSeat={props.onVisitKingdomSeat} /> : null}
        <FoundingFlow {...props} />
      </>
    );
  }
  const kingdom = props.kingdom;
  if (!kingdom) return <div className="kingdom-empty">Membership is loading its Kingdom.</div>;
  const seat = kingdom.seat;
  const canDissolve = hasPermission(props.permissions, "dissolve_kingdom");
  return (
    <div className="kingdom-stack">
      {props.snapshot?.advancementProject ? (
        <article className="kingdom-card kingdom-project-card">
          <div className="kingdom-card-heading">
            <h3>{props.snapshot.advancementProject.displayName}</h3>
            <span className="kingdom-chip">Level {props.snapshot.advancementProject.targetLevel}</span>
          </div>
          <p>Kingdom advancement is under construction.</p>
          <dl className="kingdom-facts">
            <dt>Started</dt><dd>{formatDate(props.snapshot.advancementProject.startedAt)}</dd>
            <dt>Completes</dt><dd>{formatDate(props.snapshot.advancementProject.completesAt)}</dd>
          </dl>
        </article>
      ) : null}
      {seat ? (
        <article className="kingdom-card">
          <div className="kingdom-card-heading">
            <h3>Castle</h3>
            <span className={`kingdom-chip ${seat.status}`}>{seat.constructionState === "complete" ? seat.status : "under construction"}</span>
          </div>
          <dl className="kingdom-facts">
            <dt>Members</dt><dd>{kingdom.memberCount}</dd>
            {props.snapshot?.structureCapacity ? (
              <>
                <dt>Structures</dt>
                <dd>
                  {props.snapshot.structureCapacity.used.toLocaleString()} of{" "}
                  {props.snapshot.structureCapacity.capacity.toLocaleString()} (36 per member active in
                  the last 6 days; {props.snapshot.structureCapacity.activeMembers} active)
                </dd>
              </>
            ) : null}
            <dt>Founded</dt><dd>{formatDate(kingdom.createdAt)}</dd>
            <dt>Castle territory</dt><dd>{seat.territoryRadiusM.toFixed(0)} m radius</dd>
            <dt>Environment</dt><dd>{environmentLabel(seat.environment)}</dd>
            <dt>Elevation</dt><dd>{elevationLabel(seat.environment)}</dd>
            <dt>Terrain</dt><dd>{terrainLabel(seat.environment)}</dd>
            {seat.constructionState === "under_construction" ? <><dt>Completes</dt><dd>{formatDate(seat.constructionCompletesAt ?? seat.createdAt)}</dd></> : null}
          </dl>
          {seat.constructionState === "complete" && props.onVisitKingdomSeat ? (
            <button type="button" className="kingdom-secondary" onClick={() => props.onVisitKingdomSeat?.(seat.id)}>
              Travel to Castle
            </button>
          ) : null}
        </article>
      ) : <div className="kingdom-empty">This organization currently has no active Castle.</div>}

      <article className="kingdom-card kingdom-danger-zone">
        <h3>Lifecycle</h3>
        <p>Kingdom history and ledgers are archived, never hard-deleted.</p>
        {props.membership.role !== "leader" ? (
          <ConfirmAction
            label="Leave Kingdom"
            confirmation="LEAVE"
            disabled={props.busyAction !== null}
            onConfirm={props.onLeave}
          />
        ) : <p className="kingdom-note">Transfer leadership before leaving.</p>}
        {canDissolve ? (
          <button type="button" className="kingdom-danger" disabled={props.busyAction !== null} onClick={() => void props.onDissolve()}>Dissolve Kingdom</button>
        ) : null}
      </article>
    </div>
  );
}

function FoundingFlow(props: OverviewProps): React.JSX.Element {
  const [draft, setDraft] = useState<KingdomFoundingDraft>({
    displayName: "",
    displayColor: "#7c3aed"
  });
  const setField = (field: keyof KingdomFoundingDraft, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    props.onFoundingDraftChanged();
  };
  const validIdentity = draft.displayName.trim().length > 0;
  const [foundingBuild, setFoundingBuild] = useState<{
    draft: KingdomFoundingDraft;
    countdown: FlagBuildCountdown;
  } | null>(null);
  const [foundingBuildClock, setFoundingBuildClock] = useState(Date.now());
  const [foundingBuildNotice, setFoundingBuildNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!foundingBuild) return;
    const interval = window.setInterval(() => setFoundingBuildClock(Date.now()), 100);
    const timeout = window.setTimeout(() => {
      setFoundingBuild(null);
      props.onFoundingBuildChanged?.(null);
      void props.onFound(foundingBuild.draft);
    }, Math.max(0, foundingBuild.countdown.localDeadline - Date.now()));
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [foundingBuild]);
  useEffect(() => {
    if (!foundingBuild || props.foundingQuote) return;
    setFoundingBuild(null);
    props.onFoundingBuildChanged?.(null);
    const message = props.foundingQuoteStaleReason ??
      "Kingdom construction canceled. Check the location again.";
    setFoundingBuildNotice(message);
    props.onFoundingBuildCancelled?.(message);
  }, [foundingBuild, props.foundingQuote]);
  useEffect(() => () => props.onFoundingBuildChanged?.(null), []);
  const missingResources = props.foundingQuote?.affordability
    .filter(({ missingQuantity }) => missingQuantity > 0) ?? [];
  const foundingDisabledReason = !props.foundingQuote
    ? props.foundingQuoteStaleReason
    : !props.foundingQuote.eligible
      ? props.foundingQuote.disabledReason ?? "This location is not eligible for Kingdom founding."
      : props.foundingQuote.affordable === false
        ? `Missing ${missingResources.map(({ resourceType, missingQuantity }) =>
            `${missingQuantity} ${resourceType}`).join(" and ")}.`
        : props.foundingQuote.affordable === true
          ? null
          : "Resource availability could not be verified. Check the location again.";
  const canFound = validIdentity && props.foundingQuote?.eligible === true &&
    props.foundingQuote.affordable === true && props.busyAction === null && !foundingBuild;
  const foundingBuildProgress = foundingBuild
    ? flagBuildProgress(foundingBuild.countdown, foundingBuildClock)
    : 0;
  const foundingBuildRemainingLabel = foundingBuild
    ? flagBuildRemainingTimeLabel(foundingBuild.countdown, foundingBuildClock)
    : "Finalizing\u2026";
  return (
    <article className="kingdom-card kingdom-founding">
      <div className="kingdom-card-heading">
        <h3>Found a Kingdom</h3>
        <span className="kingdom-chip">Server-authoritative</span>
      </div>
      <p>
        Stand anywhere inside territory from one of your completed personal flags. The Kingdom
        Seat will be built at your current position, while that flag remains the territorial anchor.
      </p>
      <section className="kingdom-requirements" aria-label="Kingdom founding requirements">
        <strong>Base requirements</strong>
        <dl className="kingdom-facts">
          <dt>Resources</dt><dd><MaterialChips label="Kingdom founding resources" materials={KINGDOM_FOUNDING_BASE_REQUIREMENTS.cost.map((line) => ({
            itemId: line.resourceType,
            name: resourceName(line.resourceType),
            quantity: line.quantity,
            have: props.foundingQuote?.affordability.find((entry) => entry.resourceType === line.resourceType)?.availableQuantity
          }))} /></dd>
          <dt>Level</dt><dd>Player level {KINGDOM_FOUNDING_MIN_PLAYER_LEVEL}</dd>
          <dt>Build channel</dt><dd>{KINGDOM_FOUNDING_CHANNEL_DURATION_MS / 1_000} seconds</dd>
        </dl>
        <p>
          Remain stationary during the build channel. Moving or canceling stops the build before
          any materials are spent.
        </p>
      </section>
      <label className="kingdom-field">
        <span>Name</span>
        <input
          required
          aria-label="Name"
          value={draft.displayName}
          onChange={(event) => setField("displayName", Array.from(event.currentTarget.value).slice(0, 40).join(""))}
        />
        <small>{unicodeLength(draft.displayName)}/40 characters</small>
      </label>
      <label className="kingdom-field">
        <span>Kingdom color</span>
        <input
          type="color"
          value={draft.displayColor}
          onChange={(event) => setField("displayColor", event.currentTarget.value)}
        />
      </label>
      <ol className="kingdom-flow-steps">
        <li className="done">Details</li>
        <li className={props.foundingQuote ? "done" : "active"}>Authoritative source flag</li>
        <li>Confirm</li>
      </ol>
      <button
        type="button"
        className={props.foundingQuote ? "kingdom-secondary" : "kingdom-primary"}
        disabled={!validIdentity || props.busyAction !== null || Boolean(foundingBuild)}
        onClick={() => void props.onRequestQuote(draft)}
      >
        {props.busyAction === "founding-quote"
          ? "Checking Kingdom location..."
          : props.foundingQuote
            ? "Check location again"
            : "Check Kingdom location"}
      </button>
      {props.foundingQuote ? <FoundingQuote quote={props.foundingQuote} /> : null}
      {!props.foundingQuote && props.foundingQuoteStaleReason ? (
        <p className="kingdom-alert warning" role="status">{props.foundingQuoteStaleReason}</p>
      ) : null}
      {foundingBuildNotice ? (
        <p className="kingdom-alert warning" role="status">{foundingBuildNotice}</p>
      ) : null}
      {props.foundingQuote ? (
        <>
          {props.foundingQuote.eligible && foundingDisabledReason ? (
            <p className="kingdom-alert warning" id="kingdom-founding-disabled-reason" role="status">
              {foundingDisabledReason}
            </p>
          ) : null}
          <button
            type="button"
            className="kingdom-primary"
            disabled={!canFound}
            aria-describedby={foundingDisabledReason
              ? props.foundingQuote.eligible
                ? "kingdom-founding-disabled-reason"
                : "kingdom-founding-blocker"
              : undefined}
            onClick={() => {
              const startedAt = Date.now();
              setFoundingBuildClock(startedAt);
              setFoundingBuildNotice(null);
              setFoundingBuild({
                draft,
                countdown: {
                  localStartedAt: startedAt,
                  localDeadline: startedAt + KINGDOM_FOUNDING_CHANNEL_DURATION_MS,
                  durationMs: KINGDOM_FOUNDING_CHANNEL_DURATION_MS,
                  authoritativeComplete: false
                }
              });
              if (props.foundingPosition) {
                props.onFoundingBuildChanged?.({
                  position: props.foundingPosition,
                  countdown: {
                    localStartedAt: startedAt,
                    localDeadline: startedAt + KINGDOM_FOUNDING_CHANNEL_DURATION_MS,
                    durationMs: KINGDOM_FOUNDING_CHANNEL_DURATION_MS,
                    authoritativeComplete: false
                  }
                });
              }
            }}
          >
            {foundingBuild ? "Building Kingdom..." : props.busyAction === "found" ? "Founding..." : "Build Kingdom (15s)"}
          </button>
          {foundingBuild ? (
            <div className="kingdom-founding-build" role="status" aria-live="polite">
              <div>
                <strong>Building Castle</strong>
                <output aria-label="Kingdom build time remaining">
                  {foundingBuildRemainingLabel}
                </output>
              </div>
              <div
                className="flag-build-progress"
                role="progressbar"
                aria-label="Kingdom construction progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(foundingBuildProgress * 100)}
              >
                <i style={{ width: `${foundingBuildProgress * 100}%` }} />
              </div>
              <p>Remain stationary until construction completes.</p>
              <button
                type="button"
                className="kingdom-secondary"
                onClick={() => {
                  setFoundingBuild(null);
                  props.onFoundingBuildChanged?.(null);
                  const message = "Kingdom construction canceled. No materials were spent.";
                  setFoundingBuildNotice(message);
                  props.onFoundingBuildCancelled?.(message);
                }}
              >
                Cancel Kingdom build
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="kingdom-secondary"
            disabled={props.busyAction !== null || Boolean(foundingBuild)}
            onClick={props.onCancelFoundingQuote}
          >
            Clear location check
          </button>
        </>
      ) : null}
    </article>
  );
}

function FoundingQuote({ quote }: { quote: KingdomFoundingQuoteResult }): React.JSX.Element {
  return (
    <div className="kingdom-quote" aria-label="Authoritative founding quote">
      <div className="kingdom-card-heading">
        <strong>{quote.eligible ? "Location eligible" : "Kingdom founding blocked"}</strong>
        {quote.quote?.freeConstruction ? <span className="kingdom-chip free">Free testing mode</span> : null}
      </div>
      {!quote.eligible && quote.disabledReason ? (
        <p className="kingdom-alert error" id="kingdom-founding-blocker" role="alert">{quote.disabledReason}</p>
      ) : null}
      {quote.guidance ? <p className="kingdom-note">{quote.guidance}</p> : null}
      {quote.sourceFlag ? (
        <dl className="kingdom-facts">
          <dt>Detected source flag</dt><dd><span className="owner-color-dot" style={{ backgroundColor: quote.sourceFlag.ownerColor }} aria-hidden="true" /> {quote.sourceFlag.name}</dd>
          <dt>Ownership</dt><dd>{quote.sourceFlag.ownerDisplayName ?? (quote.sourceFlag.ownedByPlayer ? "You" : "Another player")}{quote.sourceFlag.personallyControlled ? " - personally controlled" : ""}</dd>
          <dt>Territory center</dt><dd>{quote.sourceFlag.lat.toFixed(5)}, {quote.sourceFlag.lon.toFixed(5)}</dd>
          <dt>Territory radius</dt><dd>{quote.sourceFlag.claimRadiusM.toFixed(0)} m</dd>
        </dl>
      ) : null}
      {quote.environment && quote.quote ? (
        <>
          <dl className="kingdom-facts">
            <dt>Castle placement</dt><dd>{quote.seatPosition.lat.toFixed(5)}, {quote.seatPosition.lon.toFixed(5)}</dd>
            <dt>Land at Castle</dt><dd>{quote.environment.isLand && !quote.environment.isSaltwater && !quote.environment.insideMajorLake ? "Validated land" : "Rejected water"}</dd>
            <dt>Environment</dt><dd>{environmentLabel(quote.environment)}</dd>
            <dt>Elevation</dt><dd>{elevationLabel(quote.environment)}</dd>
            <dt>Terrain</dt><dd>{terrainLabel(quote.environment)}</dd>
            <dt>Cost</dt><dd>{formatCost(quote.quote.adjustedCost)}</dd>
          </dl>
        </>
      ) : null}
      {quote.affordability.length > 0 ? (
        <div className="kingdom-affordability">
          <MaterialChips label="Founding resource affordability" materials={quote.affordability.map((line) => ({
            itemId: line.resourceType,
            name: resourceName(line.resourceType),
            quantity: line.requiredQuantity,
            have: line.availableQuantity
          }))} />
        </div>
      ) : null}
      {quote.eligible ? (
        <p className="kingdom-alert success">
          This flag will remain visible as the territorial Castle source. The physical Seat
          will be built at your current position. Neighboring personal flags remain unchanged.
        </p>
      ) : null}
      <p className="kingdom-note">{quote.reservationNotice}</p>
    </div>
  );
}

function PublicKingdomOverview({
  kingdom,
  onVisitKingdomSeat
}: {
  kingdom: KingdomPublicSnapshot;
  onVisitKingdomSeat?: ((seatId: string) => void) | undefined;
}): React.JSX.Element {
  return (
    <article className="kingdom-card">
      <div className="kingdom-card-heading">
        <h3>{kingdom.displayName}</h3>
        <span className={`kingdom-chip ${kingdom.status}`}>{kingdom.status}</span>
      </div>
      {kingdom.description ? <p>{kingdom.description}</p> : null}
      <dl className="kingdom-facts">
        <dt>Level</dt><dd>{kingdom.level}</dd>
        <dt>Members</dt><dd>{kingdom.memberCount}</dd>
        <dt>Founded</dt><dd>{formatDate(kingdom.createdAt)}</dd>
        <dt>Environment</dt><dd>{kingdom.seat ? environmentLabel(kingdom.seat.environment) : "Unavailable"}</dd>
        <dt>Elevation</dt><dd>{kingdom.seat ? elevationLabel(kingdom.seat.environment) : "Unavailable"}</dd>
        <dt>Terrain</dt><dd>{kingdom.seat ? terrainLabel(kingdom.seat.environment) : "Unavailable"}</dd>
      </dl>
      {kingdom.seat?.constructionState === "complete" && onVisitKingdomSeat ? (
        <button type="button" className="kingdom-secondary" onClick={() => onVisitKingdomSeat(kingdom.seat!.id)}>
          Travel to Castle
        </button>
      ) : null}
    </article>
  );
}

type MembersSectionProps = {
  snapshot: KingdomStateSnapshot | null;
  ownPlayerId: string;
  membership: KingdomMemberSnapshot | null;
  permissions: readonly KingdomPermission[];
  busy: boolean;
  onOpenPlayer?: ((playerId: string) => void) | undefined;
  onMessagePlayer?: ((playerId: string, displayName: string) => void) | undefined;
  onInvite(playerId: string): Promise<boolean>;
  onInvitation(
    invitation: KingdomInvitationSnapshot,
    response: "accept" | "decline"
  ): Promise<boolean>;
  onCancelInvitation(invitation: KingdomInvitationSnapshot): Promise<boolean>;
  onMemberAction(member: KingdomMemberSnapshot, action: KingdomMemberAction): Promise<boolean>;
  onMute(member: KingdomMemberSnapshot, action: "mute" | "unmute", mutedUntil?: string | null): Promise<boolean>;
};

function MembersSection(props: MembersSectionProps): React.JSX.Element {
  const canCancel = hasPermission(props.permissions, "cancel_invitations");
  const pendingInvitations = props.snapshot?.invitations.filter(
    (invitation) => invitation.status === "pending"
  ) ?? [];
  return (
    <div className="kingdom-stack">
      {pendingInvitations.length > 0 ? (
        <article className="kingdom-card">
          <h3>Invitations</h3>
          <div className="kingdom-list">
            {pendingInvitations.map((invitation) => {
              const incoming = invitation.targetPlayerId === props.ownPlayerId;
              return (
                <div className="kingdom-list-row" key={invitation.id}>
                  <div>
                    <strong>{incoming ? invitation.kingdomName : invitation.targetDisplayName}</strong>
                    <span>Expires {formatDate(invitation.expiresAt)}</span>
                  </div>
                  <div className="kingdom-row-actions">
                    {incoming && !props.membership ? (
                      <>
                        <button type="button" disabled={props.busy} onClick={() => void props.onInvitation(invitation, "accept")}>Accept</button>
                        <button type="button" className="subtle" disabled={props.busy} onClick={() => void props.onInvitation(invitation, "decline")}>Decline</button>
                      </>
                    ) : null}
                    {!incoming && canCancel ? (
                      <button type="button" className="subtle" disabled={props.busy} onClick={() => void props.onCancelInvitation(invitation)}>Cancel</button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      ) : null}

      {props.membership && hasPermission(props.permissions, "invite_members") ? (
        <p className="kingdom-note">Invite eligible players from their profile. Player IDs are not required.</p>
      ) : null}

      {props.membership ? (
        <article className="kingdom-card">
          <div className="kingdom-card-heading">
            <h3>Roster</h3>
            <span>{props.snapshot?.roster.filter((member) => member.status === "active").length ?? 0} active</span>
          </div>
          <div className="kingdom-list">
            {(props.snapshot?.roster ?? []).map((member) => (
              <MemberRow key={member.membershipId} member={member} {...props} />
            ))}
          </div>
        </article>
      ) : pendingInvitations.length === 0 ? (
        <div className="kingdom-empty">No pending Kingdom invitations.</div>
      ) : null}
    </div>
  );
}

function MemberRow(
  props: MembersSectionProps & { member: KingdomMemberSnapshot }
): React.JSX.Element {
  const member = props.member;
  const mayModerate = mayModerateMember(props.membership, member);
  const canRoles = mayModerate && hasPermission(props.permissions, "manage_roles");
  const canRemove = mayModerate && hasPermission(props.permissions, "remove_members");
  const canBan = mayModerate && hasPermission(props.permissions, "ban_members");
  const canMute = mayModerate && hasPermission(props.permissions, "mute_chat");
  const canTransfer = props.membership?.role === "leader" && member.status === "active" &&
    member.playerId !== props.ownPlayerId && member.role !== "leader";
  const muted = member.chatMute.state !== "not_muted" &&
    (member.chatMute.state === "muted_indefinitely" || Date.parse(member.chatMute.mutedUntil) > Date.now());
  return (
    <div className="kingdom-list-row member">
      <button
        type="button"
        className="kingdom-member-name"
        disabled={!props.onOpenPlayer}
        onClick={() => props.onOpenPlayer?.(member.playerId)}
      >
        <strong>{member.displayName}{member.playerId === props.ownPlayerId ? " (you)" : ""}</strong>
        <span>{formatKingdomRole(member.role)} - {member.status}{muted ? " - muted" : ""}</span>
      </button>
      {member.playerId !== props.ownPlayerId && member.status === "active" && props.onMessagePlayer ? (
        <button
          type="button"
          className="kingdom-member-message"
          disabled={props.busy}
          onClick={() => props.onMessagePlayer?.(member.playerId, member.displayName)}
        >
          Message
        </button>
      ) : null}
      {mayModerate || (member.status === "banned" && hasPermission(props.permissions, "ban_members")) ? (
        <div className="kingdom-row-actions wrap">
          {canRoles && member.role === "member" ? <button type="button" disabled={props.busy} onClick={() => void props.onMemberAction(member, "promote")}>Promote</button> : null}
          {canRoles && member.role === "officer" ? <button type="button" disabled={props.busy} onClick={() => void props.onMemberAction(member, "demote")}>Demote</button> : null}
          {canMute && muted ? <button type="button" disabled={props.busy} onClick={() => void props.onMute(member, "unmute")}>Unmute</button> : null}
          {canMute && !muted ? <button type="button" disabled={props.busy} onClick={() => void props.onMute(member, "mute", new Date(Date.now() + 60 * 60_000).toISOString())}>Mute 1h</button> : null}
          {canMute && !muted ? <button type="button" disabled={props.busy} onClick={() => void props.onMute(member, "mute", null)}>Mute indefinitely</button> : null}
          {canRemove && member.status === "active" ? <button type="button" className="subtle" disabled={props.busy} onClick={() => void props.onMemberAction(member, "remove")}>Remove</button> : null}
          {canBan && member.status !== "banned" ? <button type="button" className="danger" disabled={props.busy} onClick={() => void props.onMemberAction(member, "ban")}>Ban</button> : null}
          {member.status === "banned" && hasPermission(props.permissions, "ban_members") ? <button type="button" disabled={props.busy} onClick={() => void props.onMemberAction(member, "unban")}>Unban</button> : null}
          {canTransfer ? <button type="button" className="danger" disabled={props.busy} onClick={() => void props.onMemberAction(member, "transfer_leadership")}>Transfer leadership</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function BricksSection({
  snapshot,
  busy,
  connected,
  onDepositBricks,
  onUpgradeFurnace,
  onDowngradeFurnace,
  onBuyFurnacePackage
}: {
  snapshot: KingdomStateSnapshot;
  busy: boolean;
  connected: boolean;
  onDepositBricks(quantity: number): Promise<boolean>;
  onUpgradeFurnace(targetLevel: number): Promise<boolean>;
  onDowngradeFurnace(fromLevel: number): Promise<boolean>;
  onBuyFurnacePackage(furnaceLevel: number): Promise<boolean>;
}): React.JSX.Element {
  const [quantity, setQuantity] = useState(100);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const bricks = snapshot.treasury
    .filter((balance) => balance.resourceType === "bricks")
    .reduce((total, balance) => total + balance.quantity, 0);
  const split = kingdomBrickDepositSplit(quantity);
  const furnace = snapshot.brickFurnace ?? { level: 0, lastPackageAt: null, nextPackageAt: null };
  const current = kingdomBrickFurnaceLevel(furnace.level);
  const next = furnace.level < KINGDOM_BRICK_FURNACE_MAX_LEVEL ? kingdomBrickFurnaceLevel(furnace.level + 1) : null;
  const canBuild = snapshot.permissions.includes("build_kingdom_structures");
  const cooldownMs = furnace.nextPackageAt ? Date.parse(furnace.nextPackageAt) - clock : 0;
  const cooling = cooldownMs > 0;
  return (
    <>
      <form
        className="kingdom-card"
        aria-label="Bricks"
        onSubmit={(event) => {
          event.preventDefault();
          if (!split) return;
          void onDepositBricks(split.quantity);
        }}
      >
        <h3>Bricks</h3>
        <div className="kingdom-balance-grid">
          <div><span>Treasury Bricks</span><strong>{bricks.toLocaleString()}</strong></div>
        </div>
        <p className="kingdom-note">
          Gathering and hunting on kingdom land can turn up Bricks; Obelisks multiply them. Deposits pay a
          {" "}{KINGDOM_BRICK_TAX_PERCENT}% brick tax, which is destroyed.
        </p>
        <div className="kingdom-form-grid">
          <label className="kingdom-field"><span>Bricks to deposit</span><input type="number" min={2} max={1_000_000} step={1} value={quantity} onChange={(event) => setQuantity(event.currentTarget.valueAsNumber)} /></label>
        </div>
        <p className="kingdom-note">
          {split
            ? `${split.tax.toLocaleString()} destroyed as tax · ${split.credited.toLocaleString()} reach the treasury`
            : "Deposit at least 2 Bricks."}
        </p>
        <button type="submit" className="kingdom-primary" disabled={busy || !connected || !split}>Deposit Bricks</button>
      </form>
      <article className="kingdom-card" aria-label="Brick Furnace">
        <h3>Brick Furnace{current ? ` · Level ${current.level}` : ""}</h3>
        {current ? (
          <>
            <p>
              Once every 20 hours one member can buy {current.packageBricks.toLocaleString()} Bricks for the treasury with
              {" "}{current.packageGlimmerOil} Glimmer Oil from their pack.
            </p>
            <button
              type="button"
              className="kingdom-primary"
              disabled={busy || !connected || cooling}
              onClick={() => void onBuyFurnacePackage(current.level)}
            >{cooling
              ? `Next package in ${formatCountdown(Math.ceil(cooldownMs / 1_000))}`
              : `Buy ${current.packageBricks.toLocaleString()} Bricks · ${current.packageGlimmerOil} Glimmer Oil`}</button>
          </>
        ) : (
          <p className="kingdom-note">The kingdom has no Brick Furnace yet.</p>
        )}
        {next && canBuild ? (
          <button
            type="button"
            className="kingdom-secondary"
            disabled={busy || !connected}
            onClick={() => void onUpgradeFurnace(next.level)}
          >{current ? `Upgrade to level ${next.level}` : "Build Brick Furnace"} · {next.upgradeGlimmerOil.toLocaleString()} Glimmer Oil</button>
        ) : null}
        {next && canBuild ? (
          <p className="kingdom-note">Glimmer Oil comes from the treasury when it holds enough, otherwise from your pack.</p>
        ) : null}
        {current && current.level > 1 && canBuild ? (
          <button
            type="button"
            className="kingdom-secondary"
            disabled={busy || !connected}
            onClick={() => void onDowngradeFurnace(current.level)}
          >{KINGDOM_DOWNGRADE_ACTION_LABEL}</button>
        ) : null}
      </article>
    </>
  );
}

const WAR_MATERIAL_LABELS: Readonly<Record<string, string>> = {
  bricks: "Bricks",
  pearl: "Pearl",
  refined_oil: "Glimmer Oil",
  crystal: "Crystal",
  iron: "Iron"
};

function warCostText(gold: number, materials: readonly KingdomWarMaterial[]): string {
  return [
    ...(gold > 0 ? [`${gold.toLocaleString()} gold`] : []),
    ...materials.map((material) => `${material.quantity.toLocaleString()} ${WAR_MATERIAL_LABELS[material.itemId] ?? material.itemId}`)
  ].join(" · ");
}

/** Command Board levels, caps, and raising War Towers / Outposts where the member stands. */
function CommandBoardSection({
  snapshot,
  busy,
  connected,
  onUpgrade,
  onDowngrade,
  onPlace
}: {
  snapshot: KingdomStateSnapshot;
  busy: boolean;
  connected: boolean;
  onUpgrade(targetLevel: number): Promise<boolean>;
  onDowngrade(fromLevel: number): Promise<boolean>;
  onPlace(kind: KingdomWarStructureKind): Promise<boolean>;
}): React.JSX.Element {
  const table = snapshot.commandBoard ?? {
    level: 0, warTowers: { used: 0, cap: 0 }, warOutposts: { used: 0, cap: 0 }, structures: []
  };
  const next = table.level < KINGDOM_COMMAND_BOARD_MAX_LEVEL ? kingdomCommandBoardLevel(table.level + 1) : null;
  const canBuild = snapshot.permissions.includes("build_kingdom_structures");
  const towersFull = table.warTowers.used >= table.warTowers.cap;
  const outpostsFull = table.warOutposts.used >= table.warOutposts.cap;
  return (
    <>
      <article className="kingdom-card" aria-label="Command Board">
        <h3>Command Board{table.level > 0 ? ` · Level ${table.level}` : ""}</h3>
        <div className="kingdom-balance-grid">
          <div><span>War Towers</span><strong>{table.warTowers.used} / {table.warTowers.cap}</strong></div>
          <div><span>War Outposts</span><strong>{table.warOutposts.used} / {table.warOutposts.cap}</strong></div>
        </div>
        {table.level === 0 ? <p className="kingdom-note">The kingdom has no Command Board yet. It is needed for War Towers and Outposts.</p> : null}
        {next && canBuild ? (
          <>
            <button
              type="button"
              className="kingdom-secondary"
              disabled={busy || !connected}
              onClick={() => void onUpgrade(next.level)}
            >{table.level > 0 ? `Upgrade to level ${next.level}` : "Build Command Board"} · {warCostText(0, [
              { itemId: "bricks", quantity: next.bricks },
              { itemId: "pearl", quantity: next.pearl },
              { itemId: "refined_oil", quantity: next.glimmerOil }
            ])}</button>
            <p className="kingdom-note">
              Level {next.level} allows {next.warTowers} War Towers and {next.warOutposts} War Outpost{next.warOutposts === 1 ? "" : "s"}.
              Each material comes from the treasury when it holds enough, otherwise from your pack.
            </p>
          </>
        ) : null}
        {table.level > 1 && canBuild ? (
          <button
            type="button"
            className="kingdom-secondary"
            disabled={busy || !connected}
            onClick={() => void onDowngrade(table.level)}
          >{KINGDOM_DOWNGRADE_ACTION_LABEL}</button>
        ) : null}
      </article>
      <article className="kingdom-card" aria-label="War Towers and Outposts">
        <h3>War Towers and Outposts</h3>
        <p className="kingdom-note">
          Raised where you stand: outside every territory and within 2 km of land your kingdom is at war with.
          A War Tower shoots the enemy; members can travel to a War Outpost. Both break when that war ends. Gold comes from your wallet; the leader pays materials from the treasury when it holds enough, every other member from their own pack.
        </p>
        <div className="kingdom-stack">
          <button
            type="button"
            className="kingdom-primary"
            disabled={busy || !connected || towersFull}
            onClick={() => void onPlace("war_tower")}
          >Raise War Tower · {warCostText(WAR_TOWER_GOLD_COST, WAR_TOWER_MATERIALS)}</button>
          <button
            type="button"
            className="kingdom-secondary"
            disabled={busy || !connected || outpostsFull}
            onClick={() => void onPlace("war_outpost")}
          >Raise War Outpost · {warCostText(0, WAR_OUTPOST_MATERIALS)}</button>
        </div>
        {table.structures.length === 0 ? (
          <p className="kingdom-empty">No War Towers or Outposts stand.</p>
        ) : (
          <div className="kingdom-list" aria-label="Standing war structures">
            {table.structures.map((structure) => (
              <div className="kingdom-list-row" key={structure.flagId}>
                <div>
                <strong>{kingdomWarStructureLabel(structure.kind)}</strong>
                <span>
                  {structure.health !== null && structure.maximumHealth !== null
                    ? `${structure.health.toLocaleString()} / ${structure.maximumHealth.toLocaleString()} HP`
                    : ""}
                  {structure.burning ? " · Burning" : ""}
                  {structure.enemyName ? ` · vs ${structure.enemyName}` : ""}
                </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
    </>
  );
}

function TreasurySection({
  snapshot,
  busy,
  connected,
  onDonate,
  onDepositBricks,
  onUpgradeFurnace,
  onDowngradeFurnace,
  onBuyFurnacePackage
}: {
  snapshot: KingdomStateSnapshot;
  busy: boolean;
  connected: boolean;
  onDowngradeFurnace(fromLevel: number): Promise<boolean>;
  onDonate(resourceType: ResourceType, variant: string | null, quantity: number): Promise<boolean>;
  onDepositBricks(quantity: number): Promise<boolean>;
  onUpgradeFurnace(targetLevel: number): Promise<boolean>;
  onBuyFurnacePackage(furnaceLevel: number): Promise<boolean>;
}): React.JSX.Element {
  const [resourceType, setResourceType] = useState<ResourceType>(RESOURCE_TYPES[0]);
  const [variant, setVariant] = useState("");
  const [quantity, setQuantity] = useState(1);
  return (
    <div className="kingdom-stack">
      <BricksSection
        snapshot={snapshot}
        busy={busy}
        connected={connected}
        onDepositBricks={onDepositBricks}
        onUpgradeFurnace={onUpgradeFurnace}
        onDowngradeFurnace={onDowngradeFurnace}
        onBuyFurnacePackage={onBuyFurnacePackage}
      />
      <article className="kingdom-card">
        <h3>Treasury totals</h3>
        <div className="kingdom-balance-grid">
          {snapshot.treasury.length === 0 ? <span className="kingdom-empty">Treasury is empty.</span> : null}
          {snapshot.treasury.map((balance) => (
            <div key={`${balance.resourceType}:${balance.variant ?? ""}`}>
              <span>{resourceLabel(balance.resourceType, balance.variant)}</span>
              <strong>{balance.quantity.toLocaleString()}</strong>
            </div>
          ))}
        </div>
      </article>
      <form
        className="kingdom-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!Number.isInteger(quantity) || quantity <= 0) return;
          void onDonate(resourceType, nullableText(variant), quantity).then((donated) => {
            if (donated) setQuantity(1);
          });
        }}
      >
        <h3>Donate</h3>
        <p>The server atomically moves resources from your inventory into the Kingdom ledger.</p>
        <p className="kingdom-note">
          Donations fill the treasury. Kingdom levels come from the XP members earn, not from donations.
        </p>
        <div className="kingdom-form-grid">
          <label className="kingdom-field"><span>Resource</span><select value={resourceType} onChange={(event) => setResourceType(event.currentTarget.value as ResourceType)}>{RESOURCE_TYPES.filter((resource) => resource !== "bricks").map((resource) => <option key={resource} value={resource}>{resource}</option>)}</select></label>
          <label className="kingdom-field"><span>Variant (optional)</span><input maxLength={80} value={variant} onChange={(event) => setVariant(event.currentTarget.value)} /></label>
          <label className="kingdom-field"><span>Quantity</span><input type="number" min={1} max={1_000_000} step={1} value={quantity} onChange={(event) => setQuantity(event.currentTarget.valueAsNumber)} /></label>
        </div>
        <button type="submit" className="kingdom-primary" disabled={busy || !Number.isInteger(quantity) || quantity <= 0}>Donate</button>
      </form>
      <article className="kingdom-card">
        <h3>Donation ledger</h3>
        {snapshot.donationHistory === null ? <p className="kingdom-note">Detailed ledger visibility requires permission.</p> : <DonationLedger entries={snapshot.donationHistory} />}
      </article>
      <article className="kingdom-card">
        <h3>Project spending and refunds</h3>
        {snapshot.treasuryExpenditureHistory === null ? (
          <p className="kingdom-note">Detailed ledger visibility requires permission.</p>
        ) : snapshot.treasuryExpenditureHistory.length === 0 ? (
          <div className="kingdom-empty">No project spending or refunds recorded.</div>
        ) : (
          <div className="kingdom-ledger">
            {snapshot.treasuryExpenditureHistory.map((entry) => (
              <div className={`kingdom-ledger-entry ${entry.direction}`} key={entry.id}>
                <div><strong>{entry.projectName}</strong><span>{formatDate(entry.createdAt)}</span></div>
                <span>
                  {entry.direction === "debit" ? "Spent" : "Refunded"}{" "}
                  {entry.quantity.toLocaleString()} {resourceLabel(entry.resourceType, entry.variant)}
                </span>
                <small>{entry.actorDisplayName} - balance {entry.balanceBefore.toLocaleString()} to {entry.balanceAfter.toLocaleString()}</small>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

function DonationLedger({ entries }: { entries: KingdomDonationEntry[] }): React.JSX.Element {
  if (entries.length === 0) return <div className="kingdom-empty">No donations recorded.</div>;
  return <div className="kingdom-ledger">{entries.map((entry) => <div className="kingdom-ledger-entry deposit" key={entry.id}><div><strong>{entry.donorDisplayName}</strong><span>{formatDate(entry.createdAt)}</span></div><span>{entry.quantity.toLocaleString()} {resourceLabel(entry.resourceType, entry.variant)}</span>{entry.kingdomXpGranted > 0 ? <small>+{entry.kingdomXpGranted} Kingdom XP</small> : null}</div>)}</div>;
}

function ProgressionSection({ snapshot }: { snapshot: KingdomStateSnapshot }): React.JSX.Element {
  const progression = snapshot.progression;
  if (!progression) return <div className="kingdom-empty">Kingdom progression is unavailable.</div>;
  const progressMaximum = progression.nextLevelXp ?? Math.max(progression.lifetimeXp, 1);
  const dailyCapReached = progression.dailyXp >= progression.dailyXpCap;
  return (
    <div className="kingdom-stack">
      <article className="kingdom-card">
        <p className="kingdom-section-label">Kingdom progression</p>
        <div className="kingdom-card-heading"><h3>Level {progression.level}</h3><span className="kingdom-chip">{progression.lifetimeXp.toLocaleString()} XP</span></div>
        <progress className="kingdom-progress" value={Math.min(progression.lifetimeXp, progressMaximum)} max={progressMaximum} />
        <p>
          {progression.nextLevelXp === null
            ? "Maximum Kingdom level reached."
            : `${progression.lifetimeXp.toLocaleString()} / ${progression.nextLevelXp.toLocaleString()} XP to level ${progression.level + 1}.`}
        </p>
        <dl className="kingdom-facts">
          <dt>Today</dt>
          <dd>{progression.dailyXp.toLocaleString()} / {progression.dailyXpCap.toLocaleString()} XP</dd>
        </dl>
        <p className="kingdom-note">
          Every XP point a member earns adds 1 Kingdom XP, up to {progression.dailyXpCap.toLocaleString()} per day (resets 00:00 UTC).
          {dailyCapReached ? " Today’s limit is reached." : ""}
        </p>
        <div className="kingdom-capacity-grid">
          <div><strong>{progression.capacities.memberCapacity}</strong><span>Members</span></div>
          <div><strong>{progression.capacities.seatAnchorRadiusM} m</strong><span>Seat anchor radius</span></div>
        </div>
      </article>
      <article className="kingdom-card">
        <h3>Perks</h3>
        <p className="kingdom-note">Each level from 2 to 8 opens a choice of four perks; the leader picks them on the Perks tab. Level 9 perks are coming soon. Membership qualification: {formatDurationSeconds(snapshot.perkQualificationSeconds)}.</p>
      </article>
    </div>
  );
}

/** Countdown to a server deadline, translated once through the payload's serverTime. */
function useServerCountdown(deadline: string | null, serverTime: string, onExpired: () => void): number | null {
  const offsetMs = useMemo(() => Date.parse(serverTime) - Date.now(), [serverTime]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [deadline]);
  const seconds = deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - (now + offsetMs)) / 1_000)) : null;
  const expired = seconds === 0;
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  useEffect(() => {
    if (!expired) return undefined;
    // The server settles the vote or anarchy; ask again until the new state arrives.
    onExpiredRef.current();
    const retry = window.setInterval(() => onExpiredRef.current(), 30_000);
    return () => window.clearInterval(retry);
  }, [expired]);
  return seconds;
}

function RevoltSection({
  state,
  isLeader,
  busy,
  connected,
  onDeadline,
  onStart,
  onVote
}: {
  state: KingdomRevoltState;
  isLeader: boolean;
  busy: boolean;
  connected: boolean;
  onDeadline(): void;
  onStart(): Promise<boolean>;
  onVote(revoltId: string, support: boolean): Promise<boolean>;
}): React.JSX.Element {
  const { revolt, anarchy } = state;
  const deadline = anarchy?.endsAt ?? revolt?.closesAt ?? null;
  const seconds = useServerCountdown(deadline, state.serverTime, onDeadline);
  const countdown = seconds === null ? "" : seconds === 0 ? "Settling..." : formatCountdown(seconds);
  if (anarchy) {
    return (
      <article className="kingdom-card" aria-label="Anarchy">
        <div className="kingdom-card-heading"><h3>Anarchy</h3><span className="kingdom-chip active">{countdown}</span></div>
        <p>
          A revolt removed {anarchy.deposedLeaderName}. The Kingdom has no leader, so leader-only actions are
          unavailable. Towers still defend.
        </p>
        <p className="kingdom-note">
          When anarchy ends, the member who started the revolt becomes leader if they were active in the last 6 days;
          otherwise the longest-serving active member does.
        </p>
      </article>
    );
  }
  if (!revolt) {
    return (
      <article className="kingdom-card" aria-label="Revolt">
        <div className="kingdom-card-heading">
          <h3>Revolt</h3>
          {state.boostPoints > 0 ? <span className="kingdom-chip">+{state.boostPoints} boost</span> : null}
        </div>
        <p className="kingdom-note">
          Any member can call a vote to remove the leader. It passes when more than 55% of the members active in the
          last 6 days vote yes. Each war death of the leader adds {KINGDOM_REVOLT_BOOST_PER_LEADER_DEATH} points for 2
          days, up to {KINGDOM_REVOLT_BOOST_CAP}.
        </p>
        {state.nextRevoltAt ? (
          <p className="kingdom-note">A revolt failed recently. The next vote can start {formatDate(state.nextRevoltAt)}.</p>
        ) : null}
        {isLeader ? null : (
          <button
            type="button"
            className="kingdom-secondary"
            disabled={busy || !connected || state.nextRevoltAt !== null}
            onClick={() => void onStart()}
          >
            Start revolt
          </button>
        )}
      </article>
    );
  }
  const yesShare = revolt.eligibleVoters > 0 ? (revolt.yesVotes * 100) / revolt.eligibleVoters : 0;
  return (
    <article className="kingdom-card" aria-label="Revolt vote">
      <div className="kingdom-card-heading"><h3>Revolt vote</h3><span className="kingdom-chip active">{countdown}</span></div>
      <p>{revolt.startedByName} started a revolt against {revolt.targetLeaderName}.</p>
      <progress className="kingdom-progress" value={Math.min(100, revolt.supportPercent)} max={100} aria-label="Revolt support" />
      <div className="kingdom-balance-grid">
        <div><span>Support</span><strong>{revolt.supportPercent}% of more than 55%</strong></div>
        <div><span>Yes votes</span><strong>{revolt.yesVotes} of {revolt.eligibleVoters} active ({Math.round(yesShare)}%)</strong></div>
        <div><span>No votes</span><strong>{revolt.noVotes}</strong></div>
        <div><span>Leader war-death boost</span><strong>+{revolt.boostPoints} of {KINGDOM_REVOLT_BOOST_CAP}</strong></div>
      </div>
      {revolt.boostEndsAt ? (
        <p className="kingdom-note">The boost fades by {formatDate(revolt.boostEndsAt)}.</p>
      ) : null}
      {revolt.viewerVote ? (
        <p className="kingdom-note">You voted {revolt.viewerVote === "yes" ? "for" : "against"} the revolt.</p>
      ) : null}
      {isLeader ? <p className="kingdom-note">The leader cannot vote.</p> : null}
      {revolt.viewerCanVote ? (
        <div className="kingdom-form-grid">
          <button type="button" className="kingdom-primary" disabled={busy || !connected} onClick={() => void onVote(revolt.revoltId, true)}>Vote yes</button>
          <button type="button" className="kingdom-secondary" disabled={busy || !connected} onClick={() => void onVote(revolt.revoltId, false)}>Vote no</button>
        </div>
      ) : null}
    </article>
  );
}

function ActivitySection({ snapshot }: { snapshot: KingdomStateSnapshot }): React.JSX.Element {
  return (
    <article className="kingdom-card">
      <h3>Recent activity</h3>
      {snapshot.activityHistory.length === 0 ? (
        <div className="kingdom-empty">No Kingdom activity recorded.</div>
      ) : (
        <div className="kingdom-activity-list">
          {snapshot.activityHistory.map((entry) => (
            <div key={entry.id}>
              <span>{entry.summary}</span>
              <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

type ObjectsSectionProps = {
  snapshot: KingdomStateSnapshot;
  ownPlayerId: string;
  busy: boolean;
  permissions: readonly KingdomPermission[];
  onPlaceCot(rotation: number): Promise<boolean>;
  onCotAction(cot: KingdomCotSnapshot, action: "move" | "pack"): Promise<boolean>;
  onPlaceDecoration(
    definition: KingdomDecorationDefinition,
    kingdomOwned: boolean,
    rotation: number
  ): Promise<boolean>;
  onDecorationAction(
    decoration: KingdomDecorationSnapshot,
    action: KingdomDecorationActionRequest
  ): Promise<boolean>;
};

function ObjectsSection(props: ObjectsSectionProps): React.JSX.Element {
  const [rotation, setRotation] = useState(0);
  const [ownership, setOwnership] = useState<Record<string, "personal" | "kingdom">>({});
  const ownCot = props.snapshot.cots.find(
    (cot) => cot.ownerPlayerId === props.ownPlayerId && cot.status === "active"
  );
  const activeDecorations = props.snapshot.decorations.filter(
    (decoration) => decoration.status === "active"
  );
  const decorationCapacity = props.snapshot.progression?.capacities.decorationCapacity ?? 0;
  const decorationCapacityUsed = activeDecorations.reduce((total, decoration) => total + decoration.capacityCost, 0);
  const canManageCots = hasPermission(props.permissions, "manage_cots");
  return (
    <div className="kingdom-stack">
      <article className="kingdom-card">
        <div className="kingdom-card-heading">
          <h3>Cots</h3>
          <span>{props.snapshot.cots.filter((cot) => cot.status === "active").length}/{props.snapshot.progression?.capacities.cotCapacity ?? 0}</span>
        </div>
        <p>Each active member may place one personal cot. Cots do not provide respawn, healing, banking, or travel.</p>
        {ownCot ? (
          <div className="kingdom-list-row">
            <div><strong>Your cot</strong><span>{ownCot.constructionState === "complete" ? "Complete" : `Building until ${formatDate(ownCot.constructionCompletesAt ?? ownCot.createdAt)}`} - {ownCot.lat.toFixed(5)}, {ownCot.lon.toFixed(5)} - rotation {ownCot.rotation.toFixed(0)} deg</span></div>
            <div className="kingdom-row-actions">
              <button type="button" className="subtle" disabled={props.busy || ownCot.constructionState !== "complete"} onClick={() => void props.onCotAction(ownCot, "move")}>Move here</button>
              <button type="button" className="subtle" disabled={props.busy} onClick={() => void props.onCotAction(ownCot, "pack")}>Pack cot</button>
            </div>
          </div>
        ) : (
          <button type="button" className="kingdom-primary" disabled={props.busy} onClick={() => void props.onPlaceCot(rotation)}>
            Place my cot{props.snapshot.cotConstructionQuote ? ` - ${formatCost(props.snapshot.cotConstructionQuote.adjustedCost)}` : ""}
          </button>
        )}
        {canManageCots && props.snapshot.cots.length > 0 ? (
          <details className="kingdom-details"><summary>Kingdom cot roster</summary><div className="kingdom-list">{props.snapshot.cots.map((cot) => <div className="kingdom-list-row" key={cot.id}><div><strong>{cot.ownerDisplayName}</strong><span>{cot.status} - {formatDate(cot.createdAt)}</span></div>{cot.status === "active" ? <button type="button" className="subtle" disabled={props.busy} onClick={() => void props.onCotAction(cot, "pack")}>Pack</button> : null}</div>)}</div></details>
        ) : null}
      </article>

      <article className="kingdom-card">
        <div className="kingdom-card-heading"><h3>Decoration catalog</h3><span>{decorationCapacityUsed}/{decorationCapacity} capacity units used</span></div>
        <label className="kingdom-field compact"><span>Placement rotation</span><input type="number" min={-360} max={360} step={15} value={rotation} onChange={(event) => setRotation(event.currentTarget.valueAsNumber)} /></label>
        <div className="kingdom-catalog-grid">
          {props.snapshot.decorationCatalog.map((definition) => {
            const level = props.snapshot.progression?.level ?? 0;
            const locked = definition.requiredKingdomLevel > level;
            const chosenOwnership = ownership[definition.typeId]
              ?? (definition.ownershipType === "kingdom" ? "kingdom" : "personal");
            const canPlace = !locked &&
              (definition.membersMayPlace || hasPermission(props.permissions, "place_decorations")) &&
              (!definition.officersOnly || props.snapshot.membership?.role !== "member");
            return (
              <div className={locked ? "kingdom-catalog-item locked" : "kingdom-catalog-item"} key={definition.typeId}>
                <div className={`kingdom-object-icon ${definition.typeId}`} aria-hidden="true" />
                <div><strong>{definition.displayName}</strong><span>Level {definition.requiredKingdomLevel} - {definition.capacityCost} capacity</span></div>
                <small>{definition.footprintRadiusM} m footprint - costs {definition.capacityCost} capacity units - materials {formatCost(definition.constructionQuote?.adjustedCost ?? definition.futureMaterialCost)} - {formatDurationSeconds(definition.constructionQuote?.adjustedConstructionSeconds ?? definition.intendedConstructionSeconds)}</small>
                {definition.ownershipType === "choice" ? (
                  <select aria-label={`${definition.displayName} ownership`} value={chosenOwnership} onChange={(event) => setOwnership((current) => ({ ...current, [definition.typeId]: event.currentTarget.value as "personal" | "kingdom" }))}>
                    <option value="personal">Personal</option><option value="kingdom">Kingdom-owned</option>
                  </select>
                ) : <span className="kingdom-chip">{definition.ownershipType}</span>}
                <button type="button" disabled={props.busy || !canPlace || !Number.isFinite(rotation)} onClick={() => void props.onPlaceDecoration(definition, chosenOwnership === "kingdom", rotation)}>{locked ? `Unlocks at level ${definition.requiredKingdomLevel}` : "Place"}</button>
              </div>
            );
          })}
        </div>
        {props.snapshot.freeConstruction ? <div className="kingdom-alert testing">Testing mode: eligible construction completes immediately without consuming the displayed future materials.</div> : null}
      </article>

      <article className="kingdom-card">
        <h3>Placed decorations</h3>
        {activeDecorations.length === 0 ? <div className="kingdom-empty">No decorations placed.</div> : null}
        <div className="kingdom-list">
          {activeDecorations.map((decoration) => {
            const personalOwner = decoration.personalOwnerPlayerId === props.ownPlayerId;
            const canMove = decoration.constructionState === "complete" && (personalOwner || hasPermission(props.permissions, "move_decorations") || (decoration.kingdomOwned && hasPermission(props.permissions, "manage_kingdom_decorations")));
            const canRemove = personalOwner || hasPermission(props.permissions, "remove_decorations") || (decoration.kingdomOwned && hasPermission(props.permissions, "manage_kingdom_decorations"));
            return (
              <div className="kingdom-list-row" key={decoration.id}>
                <div><strong>{decoration.displayName}</strong><span>{decoration.constructionState === "complete" ? "Complete" : `Building until ${formatDate(decoration.constructionCompletesAt ?? decoration.createdAt)}`} - {decoration.kingdomOwned ? "Kingdom-owned" : personalOwner ? "Yours" : "Personal"} - {decoration.lat.toFixed(5)}, {decoration.lon.toFixed(5)}</span></div>
                <div className="kingdom-row-actions">
                  {canMove ? <button type="button" disabled={props.busy} onClick={() => void props.onDecorationAction(decoration, { decorationId: decoration.id, action: "move", rotation: decoration.rotation })}>Move</button> : null}
                  {canRemove ? <button type="button" className="danger" disabled={props.busy} onClick={() => void props.onDecorationAction(decoration, { decorationId: decoration.id, action: "remove" })}>Remove</button> : null}
                </div>
              </div>
            );
          })}
        </div>
      </article>
    </div>
  );
}

function ConfirmAction({
  label,
  confirmation,
  disabled,
  danger = false,
  onConfirm
}: {
  label: string;
  confirmation: string;
  disabled: boolean;
  danger?: boolean;
  onConfirm(): Promise<boolean>;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  return (
    <div className="kingdom-confirm-action">
      <label className="kingdom-field"><span>Type <strong>{confirmation}</strong> to confirm</span><input value={value} onChange={(event) => setValue(event.currentTarget.value)} /></label>
      <button type="button" className={danger ? "kingdom-danger" : "kingdom-secondary"} disabled={disabled || value !== confirmation} onClick={() => void onConfirm().then((completed) => { if (completed) setValue(""); })}>{label}</button>
    </div>
  );
}

function displayError(reason: unknown): string {
  if (reason instanceof KingdomApiError) {
    return kingdomErrorMessage(reason.code, reason.message);
  }
  return reason instanceof Error ? reason.message : "Kingdom request failed";
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

type KingdomEnvironmentDisplay = {
  terrainClass: string | null;
  biome: string | null;
  ecoregion?: string | null;
  elevationBand: string | null;
  elevationM: number | null;
};

function environmentLabel(environment: KingdomEnvironmentDisplay): string {
  return worldLayerLabel(environment.biome ?? environment.ecoregion, "Unknown");
}

function elevationLabel(environment: KingdomEnvironmentDisplay): string {
  const band = environment.elevationBand
    ? worldLayerLabel(environment.elevationBand, "Unknown")
    : null;
  const meters = environment.elevationM === null
    ? null
    : `${environment.elevationM.toLocaleString(undefined, { maximumFractionDigits: 0 })} m`;
  return [band, meters].filter(Boolean).join(" · ") || "Unknown";
}

function terrainLabel(environment: KingdomEnvironmentDisplay): string {
  return worldLayerLabel(environment.terrainClass, "Unknown");
}

function worldLayerLabel(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCost(cost: readonly { resourceType: string; quantity: number }[]): string {
  return cost.length === 0
    ? "TBD / no supported material cost"
    : cost.map((line) => `${line.quantity} ${line.resourceType}`).join(", ");
}

function resourceName(resourceType: string): string {
  return resourceType.length > 0
    ? `${resourceType[0]!.toUpperCase()}${resourceType.slice(1).replaceAll("_", " ")}`
    : resourceType;
}

function resourceLabel(resourceType: string, variant: string | null): string {
  return variant && variant !== "default" ? `${resourceType} (${variant})` : resourceType;
}

function rubbleCostText(rubble: KingdomCastleRubbleSnapshot): string {
  return rubble.rebuildCost.length === 0
    ? "free"
    : rubble.rebuildCost.map((line) => `${line.quantity.toLocaleString()} ${resourceLabel(line.resourceType, null)}`).join(" · ");
}

/** A Castle in rubble: perks are off and building stops until the leader rebuilds or (after 7 days) disbands. */
function CastleRubbleCard({
  rubble,
  isLeader,
  busy,
  connected,
  onRebuild,
  onDisband
}: {
  rubble: KingdomCastleRubbleSnapshot;
  isLeader: boolean;
  busy: boolean;
  connected: boolean;
  onRebuild(): void;
  onDisband(): void;
}): React.JSX.Element {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const disbandInMs = Date.parse(rubble.disbandAvailableAt) - clock;
  const disbandLocked = disbandInMs > 0;
  return (
    <article className="kingdom-card" aria-label="Castle in rubble">
      <h3>Castle in rubble</h3>
      <p>
        The Castle fell {formatDate(rubble.ruinedAt)}. Kingdom perks give nothing and members cannot build until it is
        rebuilt. The kingdom keeps its members, flags and treasury.
      </p>
      {isLeader ? (
        <div className="kingdom-stack">
          <button type="button" className="kingdom-primary" disabled={busy || !connected} onClick={onRebuild}>
            Rebuild Castle · {rubbleCostText(rubble)}
          </button>
          <button
            type="button"
            className="kingdom-danger"
            disabled={busy || !connected || disbandLocked}
            onClick={onDisband}
          >{disbandLocked ? `Disband in ${formatLongCountdown(Math.ceil(disbandInMs / 1_000))}` : "Disband Kingdom"}</button>
        </div>
      ) : (
        <p className="kingdom-note">Only the leader can rebuild the Castle or disband the kingdom.</p>
      )}
    </article>
  );
}

/** Days and hours for long waits; the hour clock below a day. */
function formatLongCountdown(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  return days > 0 ? `${days}d ${Math.floor((totalSeconds % 86_400) / 3_600)}h` : formatCountdown(totalSeconds);
}

function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${minutes}m ${seconds}s`;
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
