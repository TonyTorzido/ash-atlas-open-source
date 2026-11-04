import type {
  CollectibleNode,
  CollectibleSnapshotAuthority,
  WorldResourcePresentationDomain
} from "@ash-atlas/shared";

export type WorldResourceRemovalReason =
  | "killed"
  | "harvested"
  | "depleted-state-representation-change"
  | "generation-retired"
  | "left-authoritative-visibility"
  | "connection-replaced"
  | "actual-plan-cutover"
  | "lease-rebound-in-place"
  | "lease-ownership-lost"
  | "explicit-server-removal";

export type BlockedWorldResourceRemovalReason =
  | "partial-snapshot-omission"
  | "loading-snapshot-omission"
  | "failed-snapshot-omission"
  | "truncated-snapshot-omission"
  | "unrelated-domain-replacement";

export type WorldResourcePresentationMetrics = Readonly<{
  removals: Readonly<Partial<Record<WorldResourceRemovalReason, number>>>;
  blockedRemovals: Readonly<
    Partial<Record<BlockedWorldResourceRemovalReason, number>>
  >;
  incompleteSnapshots: number;
  truncatedSnapshots: number;
  unexplainedRemovals: number;
  renderMaterializations: number;
}>;

export type WorldResourceRemovalDiagnostic = Readonly<{
  domain: WorldResourcePresentationDomain;
  actualDomain: WorldResourcePresentationDomain;
  entityKind: string;
  entityId: string;
  worldEpoch: string | null;
  reason: "cross-domain-removal";
  attemptedReason: WorldResourceRemovalReason;
}>;

type DomainState = {
  nodes: Map<string, CollectibleNode>;
  snapshotAuthority: CollectibleSnapshotAuthority | null;
};

type RevisionTombstone = Readonly<{
  domain: "population" | "repeatable-resource";
  revision: number;
}>;

export class WorldResourcePresentationStore {
  private readonly domains = new Map<WorldResourcePresentationDomain, DomainState>([
    ["population", { nodes: new Map(), snapshotAuthority: null }],
    ["repeatable-resource", { nodes: new Map(), snapshotAuthority: null }],
    ["resource-vision", { nodes: new Map(), snapshotAuthority: null }]
  ]);
  private readonly removals:
    Partial<Record<WorldResourceRemovalReason, number>> = {};
  private readonly blockedRemovals:
    Partial<Record<BlockedWorldResourceRemovalReason, number>> = {};
  private incompleteSnapshots = 0;
  private truncatedSnapshots = 0;
  private unexplainedRemovals = 0;
  private renderMaterializations = 0;
  private worldEpoch: string | null = null;
  private readonly collectibleTombstones = new Map<string, RevisionTombstone>();

  constructor(
    initialNodes: readonly CollectibleNode[] = [],
    private readonly onUnexplainedRemoval?: (
      diagnostic: WorldResourceRemovalDiagnostic
    ) => void
  ) {
    for (const node of initialNodes) {
      const domain = presentationDomainForNode(node);
      this.domain(domain).nodes.set(node.id, {
        ...node,
        presentationOwner: domain
      });
    }
  }

  reset(): void {
    for (const state of this.domains.values()) {
      state.nodes.clear();
      state.snapshotAuthority = null;
    }
    this.worldEpoch = null;
  }

  setWorldEpoch(worldEpoch: string | null): void {
    this.worldEpoch = worldEpoch;
  }

  metrics(): WorldResourcePresentationMetrics {
    return {
      removals: { ...this.removals },
      blockedRemovals: { ...this.blockedRemovals },
      incompleteSnapshots: this.incompleteSnapshots,
      truncatedSnapshots: this.truncatedSnapshots,
      unexplainedRemovals: this.unexplainedRemovals,
      renderMaterializations: this.renderMaterializations
    };
  }

  replacePopulation(
    upserts: readonly CollectibleNode[],
    removedIds: ReadonlySet<string>,
    _replacesProjection: boolean,
    worldEpoch?: string
  ): CollectibleNode[] {
    if (worldEpoch !== undefined) this.worldEpoch ??= worldEpoch;
    const state = this.domain("population");
    for (const id of removedIds) {
      if (state.nodes.delete(id)) this.recordRemoval("explicit-server-removal");
    }
    for (const node of upserts) {
      this.upsertRaw("population", node);
    }
    return this.renderList();
  }

  applySnapshot(input: Readonly<{
    authority: CollectibleSnapshotAuthority;
    nodes: readonly CollectibleNode[];
    repeatableNodes: readonly CollectibleNode[];
  }>): CollectibleNode[] {
    this.worldEpoch ??= [
      input.authority.scope.kind,
      input.authority.scope.id,
      input.authority.gameplayViewGeneration,
      input.authority.snapshotGeneration
    ].join(":");
    if (input.authority.completeness !== "complete") {
      this.incompleteSnapshots += 1;
    }
    if (input.authority.ordinaryNodesTruncated) {
      this.truncatedSnapshots += 1;
    }
    this.applyPopulationSnapshot(
      input.nodes.filter((node) =>
        presentationDomainForNode(node) === "population"
      ),
      input.authority
    );
    this.applyOwnedSnapshot(
      "resource-vision",
      input.nodes.filter((node) =>
        presentationDomainForNode(node) === "resource-vision"
      ),
      input.authority
    );
    this.applyOwnedSnapshot(
      "repeatable-resource",
      input.repeatableNodes,
      input.authority
    );
    return this.renderList();
  }

  upsert(
    domain: WorldResourcePresentationDomain,
    node: CollectibleNode
  ): CollectibleNode[] {
    this.upsertRaw(domain, node);
    return this.renderList();
  }

  removeBatch(removals: Iterable<Readonly<{
    domain?: WorldResourcePresentationDomain;
    nodeId: string;
    stateRevision?: number;
    reason: WorldResourceRemovalReason;
  }>>): CollectibleNode[] {
    for (const removal of removals) {
      this.recordTombstone(
        removal.nodeId,
        removal.domain,
        removal.stateRevision
      );
      if (removal.domain) {
        this.removeRaw(removal.domain, removal.nodeId, removal.reason);
      } else {
        this.removeOwnedRaw(removal.nodeId, removal.reason);
      }
    }
    return this.renderList();
  }

  private upsertRaw(
    domain: WorldResourcePresentationDomain,
    node: CollectibleNode
  ): void {
    const tombstone = this.collectibleTombstones.get(node.id);
    if (tombstone?.domain === domain) {
      const incomingRevision = domain === "population"
        ? node.treeLifeRevision
        : domain === "repeatable-resource"
          ? node.repeatableRevision
          : undefined;
      if (
        incomingRevision === undefined
        || incomingRevision <= tombstone.revision
      ) return;
      this.collectibleTombstones.delete(node.id);
    }
    const state = this.domain(domain);
    const incoming = { ...node, presentationOwner: domain };
    const current = state.nodes.get(node.id);
    if (
      domain === "repeatable-resource"
      && current?.repeatableRevision !== undefined
      && incoming.repeatableRevision !== undefined
      && current.repeatableRevision > incoming.repeatableRevision
    ) {
      return;
    }
    if (
      domain === "population"
      && current?.treeLifeRevision !== undefined
      && incoming.treeLifeRevision !== undefined
      && current.treeLifeRevision > incoming.treeLifeRevision
    ) {
      return;
    }
    if (
      domain === "population"
      && current?.treeLifeRevision !== undefined
      && current.treeLifeRevision === incoming.treeLifeRevision
      && (current.resinAvailable === false || incoming.resinAvailable === false)
    ) {
      incoming.resinAvailable = false;
    }
    if (domain === "population" && current?.treeLifeRevision !== undefined
      && current.treeLifeRevision === incoming.treeLifeRevision
      && (current.berryAvailable === false || incoming.berryAvailable === false)) {
      incoming.berryAvailable = false;
    }
    if (domain === "population") {
      const sapReadyAt = laterSapReadyAt(current?.sapReadyAt, incoming.sapReadyAt);
      if (sapReadyAt !== undefined) incoming.sapReadyAt = sapReadyAt;
    }
    state.nodes.set(node.id, incoming);
  }

  remove(
    domain: WorldResourcePresentationDomain,
    nodeId: string,
    reason: WorldResourceRemovalReason
  ): CollectibleNode[] {
    this.removeRaw(domain, nodeId, reason);
    return this.renderList();
  }

  private removeRaw(
    domain: WorldResourcePresentationDomain,
    nodeId: string,
    reason: WorldResourceRemovalReason
  ): void {
    const state = this.domain(domain);
    if (state.nodes.delete(nodeId)) {
      this.recordRemoval(reason);
    } else {
      const actual = this.findOwnedNode(nodeId);
      if (actual && actual.domain !== domain) {
        this.unexplainedRemovals += 1;
        this.onUnexplainedRemoval?.({
          domain,
          actualDomain: actual.domain,
          entityKind:
            actual.node.repeatableNodeType ??
            actual.node.type,
          entityId: nodeId,
          worldEpoch: this.worldEpoch,
          reason: "cross-domain-removal",
          attemptedReason: reason
        });
      }
    }
  }

  removeOwned(
    nodeId: string,
    reason: WorldResourceRemovalReason
  ): CollectibleNode[] {
    this.removeOwnedRaw(nodeId, reason);
    return this.renderList();
  }

  private removeOwnedRaw(
    nodeId: string,
    reason: WorldResourceRemovalReason
  ): void {
    for (const domain of [
      "repeatable-resource",
      "population",
      "resource-vision"
    ] as const) {
      if (!this.domain(domain).nodes.has(nodeId)) continue;
      this.removeRaw(domain, nodeId, reason);
      return;
    }
  }

  mutate(
    nodeId: string,
    update: (node: CollectibleNode) => CollectibleNode
  ): CollectibleNode[] {
    for (const state of this.domains.values()) {
      const current = state.nodes.get(nodeId);
      if (!current) continue;
      state.nodes.set(nodeId, update(current));
      break;
    }
    return this.renderList();
  }

  renderList(): CollectibleNode[] {
    this.renderMaterializations += 1;
    const combined = new Map<string, CollectibleNode>();
    for (const domain of [
      "resource-vision",
      "population",
      "repeatable-resource"
    ] as const) {
      for (const [id, node] of this.domain(domain).nodes) combined.set(id, node);
    }
    return [...combined.values()];
  }

  private applyOwnedSnapshot(
    domain: "resource-vision" | "repeatable-resource",
    nodes: readonly CollectibleNode[],
    authority: CollectibleSnapshotAuthority
  ): void {
    if (!authority.includedDomains.includes(domain)) return;
    const state = this.domain(domain);
    if (!snapshotAdvances(state.snapshotAuthority, authority)) return;
    if (
      authority.completeness === "complete"
      && !authority.ordinaryNodesTruncated
    ) {
      const incomingIds = new Set(nodes.map((node) => node.id));
      for (const id of state.nodes.keys()) {
        if (!incomingIds.has(id) && state.nodes.delete(id)) {
          this.recordRemoval("left-authoritative-visibility");
        }
      }
    } else {
      const incomingIds = new Set(nodes.map((node) => node.id));
      const omittedCount = [...state.nodes.keys()].filter(
        (id) => !incomingIds.has(id)
      ).length;
      if (omittedCount > 0) {
        const reason: BlockedWorldResourceRemovalReason =
          authority.ordinaryNodesTruncated
            ? "truncated-snapshot-omission"
            : authority.completeness === "loading"
              ? "loading-snapshot-omission"
              : authority.completeness === "failed"
                ? "failed-snapshot-omission"
                : "partial-snapshot-omission";
        this.blockedRemovals[reason] =
          (this.blockedRemovals[reason] ?? 0) + omittedCount;
      }
    }
    for (const node of nodes) this.upsertRaw(domain, node);
    state.snapshotAuthority = authority;
  }

  private applyPopulationSnapshot(
    nodes: readonly CollectibleNode[],
    authority: CollectibleSnapshotAuthority
  ): void {
    if (!authority.includedDomains.includes("population")) return;
    const state = this.domain("population");
    if (!snapshotAdvances(state.snapshotAuthority, authority)) return;
    for (const node of nodes) this.upsertRaw("population", node);
    state.snapshotAuthority = authority;
  }

  private domain(domain: WorldResourcePresentationDomain): DomainState {
    return this.domains.get(domain)!;
  }

  private findOwnedNode(nodeId: string): Readonly<{
    domain: WorldResourcePresentationDomain;
    node: CollectibleNode;
  }> | null {
    for (const domain of [
      "population",
      "repeatable-resource",
      "resource-vision"
    ] as const) {
      const node = this.domain(domain).nodes.get(nodeId);
      if (node) return { domain, node };
    }
    return null;
  }

  private recordRemoval(reason: WorldResourceRemovalReason): void {
    this.removals[reason] = (this.removals[reason] ?? 0) + 1;
  }

  private recordTombstone(
    nodeId: string,
    requestedDomain?: WorldResourcePresentationDomain,
    stateRevision?: number
  ): void {
    const owned = this.findOwnedNode(nodeId);
    const prior = this.collectibleTombstones.get(nodeId);
    const domain = requestedDomain ?? owned?.domain ?? prior?.domain;
    let revision: number | undefined;
    if (domain === "population") {
      const treeLifeRevision = owned?.domain === "population"
        ? owned.node.treeLifeRevision
        : undefined;
      if (treeLifeRevision !== undefined) {
        revision = Math.max(
          treeLifeRevision,
          stateRevision ?? 0,
          prior?.domain === "population" ? prior.revision : 0
        );
      } else if (
        stateRevision !== undefined
        || prior?.domain === "population"
      ) {
        revision = Math.max(
          stateRevision ?? 0,
          prior?.domain === "population" ? prior.revision : 0
        );
      }
    } else if (domain === "repeatable-resource") {
      const repeatableRevision = owned?.domain === "repeatable-resource"
        ? owned.node.repeatableRevision
        : undefined;
      if (
        repeatableRevision !== undefined
        || stateRevision !== undefined
        || prior?.domain === "repeatable-resource"
      ) {
        revision = Math.max(
          repeatableRevision ?? 0,
          stateRevision ?? 0,
          prior?.domain === "repeatable-resource" ? prior.revision : 0
        );
      }
    }
    if (
      revision === undefined
      || (domain !== "population" && domain !== "repeatable-resource")
    ) return;
    this.collectibleTombstones.delete(nodeId);
    this.collectibleTombstones.set(nodeId, { domain, revision });
    while (this.collectibleTombstones.size > 512) {
      const oldest = this.collectibleTombstones.keys().next().value;
      if (oldest === undefined) break;
      this.collectibleTombstones.delete(oldest);
    }
  }
}

function presentationDomainForNode(
  node: CollectibleNode
): WorldResourcePresentationDomain {
  if (node.presentationOwner) return node.presentationOwner;
  if (node.repeatableNodeType) return "repeatable-resource";
  if (node.treeLifeRevision !== undefined) return "population";
  return "resource-vision";
}

function snapshotAdvances(
  current: CollectibleSnapshotAuthority | null,
  incoming: CollectibleSnapshotAuthority
): boolean {
  if (!current) return true;
  if (incoming.snapshotGeneration !== current.snapshotGeneration) {
    return incoming.snapshotGeneration > current.snapshotGeneration;
  }
  if (incoming.gameplayViewGeneration !== current.gameplayViewGeneration) {
    return incoming.gameplayViewGeneration > current.gameplayViewGeneration;
  }
  if (
    incoming.scope.kind !== current.scope.kind
    || incoming.scope.id !== current.scope.id
  ) {
    return true;
  }
  return incoming.snapshotId !== current.snapshotId;
}

/** The later of two Elder Frond sap ready times (a newer tap wins; null = never tapped). */
function laterSapReadyAt(
  current: string | null | undefined,
  incoming: string | null | undefined
): string | null | undefined {
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  if (current === null) return incoming;
  if (incoming === null) return current;
  return Date.parse(incoming) >= Date.parse(current) ? incoming : current;
}
