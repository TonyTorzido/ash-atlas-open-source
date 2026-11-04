import type { ClientMessage, FlagReinforcementTarget, PersonalAnchorKind } from "@ash-atlas/shared";
import { perfMetrics } from "../../perf/perfMetrics.js";
import { perfRecorder } from "../../perf/perfRecorder.js";
import { requestIdCrypto as crypto } from "../../requestId.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";
import { requestActionFix } from "../../location/actionFixHook.js";

export class FlagClient {
  constructor(private readonly port: ClientCommandPort) {}

  placeFlag(name?: string, quoteId?: string, anchorKind?: PersonalAnchorKind): string | null {
      const requestId = crypto.randomUUID();
      const sent = this.send({
        type: "PLACE_FLAG",
        requestId,
        name,
        quoteId,
        anchorKind
      });
      if (!sent) return null;
      requestActionFix("action_flag_place");
      perfRecorder.recordEvent("flag_place_ws_sent", {
        requestId,
        quoteIdPresent: quoteId !== undefined
      });
      gameplayLatencyTrace.record("build", "build_request_transmitted", {
        requestId,
        quoteIdPresent: quoteId !== undefined,
        quoteId: quoteId ?? null
      }, { traceId: requestId });
      return requestId;
    }

  cancelFlagBuild(buildId: string): boolean {
      return this.send({ type: "CANCEL_FLAG_BUILD", requestId: crypto.randomUUID(), buildId });
    }

  reinforceFlag(flagId: string): boolean {
      return this.upgradeFlag(flagId, "stone");
    }

  upgradeFlag(flagId: string, targetTier: FlagReinforcementTarget, targetTowerLevel?: number): boolean {
      return this.send({
        type: "REINFORCE_FLAG",
        requestId: crypto.randomUUID(),
        flagId,
        targetTier,
        ...((targetTier === "tower_level" || targetTier === "kingdom_tower" || targetTier === "obelisk") &&
          targetTowerLevel !== undefined
          ? { targetTowerLevel }
          : {})
      });
  }

  startFlagBurn(flagId: string, requestId: string = crypto.randomUUID()): string | null {
    const sent = this.send({ type: "START_FLAG_BURN", requestId, flagId });
    if (sent) requestActionFix("action_flag_attack");
    return sent ? requestId : null;
  }

  attackFlag(flagId: string, requestId: string = crypto.randomUUID()): string | null {
    const sent = this.send({ type: "ATTACK_FLAG", requestId, flagId });
    if (sent) requestActionFix("action_flag_attack");
    return sent ? requestId : null;
  }

  startFlagRepair(flagId: string, requestId: string = crypto.randomUUID()): string | null {
    const sent = this.send({ type: "START_FLAG_REPAIR", requestId, flagId });
    return sent ? requestId : null;
  }

  cancelFlagRepair(flagId: string, operationId: string, requestId: string = crypto.randomUUID()): boolean {
    return this.send({ type: "CANCEL_FLAG_REPAIR", requestId, flagId, operationId });
  }

  startFlagRepairDisrupt(flagId: string, repairOperationId: string, requestId: string = crypto.randomUUID()): string | null {
    const sent = this.send({ type: "START_FLAG_REPAIR_DISRUPT", requestId, flagId, repairOperationId });
    return sent ? requestId : null;
  }

  cancelFlagRepairDisrupt(flagId: string, operationId: string, requestId: string = crypto.randomUUID()): boolean {
    return this.send({ type: "CANCEL_FLAG_REPAIR_DISRUPT", requestId, flagId, operationId });
  }

  craftTorch(requestId: string = crypto.randomUUID()): string | null {
    const sent = this.send({ type: "CRAFT_TORCH", requestId });
    return sent ? requestId : null;
  }

  surveyArea(): void {
      perfMetrics.noteSurveyRequest();
      this.send({
        type: "SURVEY_AREA",
        requestId: crypto.randomUUID()
      });
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
