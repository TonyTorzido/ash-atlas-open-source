import { describe, expect, it, vi } from "vitest";

import { ensureRetainedEntity, pruneRetainedEntities } from "./retainedEntityMap.js";

describe("retained dynamic entity map", () => {
  it("does not recreate unchanged display objects on ordinary frames", () => {
    const entities = new Map<string, { id: number }>();
    const create = vi.fn(() => ({ id: 1 }));
    const first = ensureRetainedEntity(entities, "mob:1", create);
    const second = ensureRetainedEntity(entities, "mob:1", create);
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledOnce();
  });

  it("destroys only entities that leave interest", () => {
    const destroy = vi.fn();
    const entities = new Map([
      ["keep", { id: 1 }],
      ["remove", { id: 2 }]
    ]);
    pruneRetainedEntities(entities, new Set(["keep"]), destroy);
    expect([...entities.keys()]).toEqual(["keep"]);
    expect(destroy).toHaveBeenCalledWith({ id: 2 });
  });

  it("destroys a retained mob as soon as an authoritative removal prunes it", () => {
    const mob = { id: "mob:lethal" };
    const destroy = vi.fn();
    const entities = new Map([[mob.id, mob]]);

    pruneRetainedEntities(entities, new Set(), destroy);

    expect(entities.has(mob.id)).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(mob);
  });
});
