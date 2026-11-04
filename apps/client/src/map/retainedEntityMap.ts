export function ensureRetainedEntity<T>(
  entities: Map<string, T>,
  entityId: string,
  create: () => T
): T {
  const existing = entities.get(entityId);
  if (existing) {
    return existing;
  }
  const created = create();
  entities.set(entityId, created);
  return created;
}

export function pruneRetainedEntities<T>(
  entities: Map<string, T>,
  desiredEntityIds: ReadonlySet<string>,
  destroy: (entity: T) => void
): void {
  for (const [entityId, entity] of entities) {
    if (!desiredEntityIds.has(entityId)) {
      destroy(entity);
      entities.delete(entityId);
    }
  }
}
