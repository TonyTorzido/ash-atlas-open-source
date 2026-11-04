export type CombatRuleContext = {
  attacker: {
    entityId: string;
    kind: "player" | "mob";
    regionCode: string;
    zoneId: string;
  };
  target: {
    entityId: string;
    kind: "player" | "mob";
    regionCode: string;
    zoneId: string;
  };
};

export interface CombatRules {
  canAttack(context: CombatRuleContext): boolean;
}

export const developmentCombatRules: CombatRules = {
  canAttack({ attacker, target }): boolean {
    return (
      attacker.entityId !== target.entityId &&
      (
        attacker.kind !== target.kind ||
        (
          attacker.regionCode === target.regionCode &&
          attacker.zoneId === target.zoneId
        )
      )
    );
  }
};
