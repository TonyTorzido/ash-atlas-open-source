import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  HEALTH_BAR_TIMING,
  healthPercent,
  isCriticalHealth,
  wardBarPresentation
} from "../combat/healthBarPresentation.js";

type HealthBarTrackProps = {
  current: number;
  maximum: number;
  ward?: number;
  label: string;
  className?: string;
  children?: ReactNode;
};

export function HealthBarTrack({
  current,
  maximum,
  ward = 0,
  label,
  className = "",
  children = null
}: HealthBarTrackProps): React.JSX.Element {
  const percent = healthPercent(current, maximum);
  const previousPercentRef = useRef(percent);
  const hideTrailTimerRef = useRef<number | null>(null);
  const [damageTrailActive, setDamageTrailActive] = useState(false);
  const takingDamage = percent < previousPercentRef.current;
  const healing = percent > previousPercentRef.current;
  const showDamageTrail = !healing && (takingDamage || damageTrailActive);
  const safeMaximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 0;
  const safeCurrent = Number.isFinite(current)
    ? Math.min(safeMaximum, Math.max(0, current))
    : 0;
  const safeWard = Number.isFinite(ward) ? Math.max(0, ward) : 0;
  const wardPresentation = wardBarPresentation(safeCurrent, safeMaximum, safeWard);
  const wardPercent = wardPresentation.widthRatio * 100;
  const wardLeftPercent = wardPresentation.leftRatio * 100;

  useEffect(() => {
    const previousPercent = previousPercentRef.current;
    previousPercentRef.current = percent;
    if (hideTrailTimerRef.current !== null) {
      window.clearTimeout(hideTrailTimerRef.current);
      hideTrailTimerRef.current = null;
    }
    if (percent < previousPercent) {
      setDamageTrailActive(true);
      hideTrailTimerRef.current = window.setTimeout(() => {
        setDamageTrailActive(false);
        hideTrailTimerRef.current = null;
      }, HEALTH_BAR_TIMING.damageTrailHoldMs + HEALTH_BAR_TIMING.damageTrailDrainMs);
    } else if (percent > previousPercent) {
      setDamageTrailActive(false);
    }
    return () => {
      if (hideTrailTimerRef.current !== null) {
        window.clearTimeout(hideTrailTimerRef.current);
        hideTrailTimerRef.current = null;
      }
    };
  }, [percent]);

  const fillWidth = percent > 0 ? `max(1px, ${percent}%)` : "0%";
  return (
    <div
      className={`${className} hp-bar-track${isCriticalHealth(current, maximum) ? " is-critical" : ""}`.trim()}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMaximum}
      aria-valuenow={safeCurrent}
      aria-valuetext={`${safeCurrent} of ${safeMaximum} health${safeWard > 0 ? `, ${safeWard} Ward` : ""}`}
    >
      <span className="hp-bar-recess" aria-hidden="true">
        <i
          className="hp-bar-damage-trail"
          data-active={showDamageTrail ? "true" : "false"}
          style={{ width: fillWidth }}
        />
        <i className="status-bar-track-fill hp-bar-fill" style={{ width: fillWidth }} />
        {safeWard > 0 ? <i
          className="hp-bar-ward"
          data-ward={safeWard}
          style={{ left: `${wardLeftPercent}%`, width: `${wardPercent}%` }}
        /> : null}
      </span>
      {children}
    </div>
  );
}
