import { useId } from "react";

import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";

// The entry-path loading surface. It shares its markup and styles
// (public/initial-curtain.css) with the static first frame in index.html, so
// every step from app launch to the first world frame looks like one screen.
export function BootScreen({
  title,
  detail,
  progress,
  progressLabel,
  role = "status",
  embedded = false,
  showBar = true,
  children
}: {
  title: string;
  detail?: string | undefined;
  progress?: number | null | undefined;
  progressLabel?: string | undefined;
  role?: "status" | "alert" | "alertdialog";
  embedded?: boolean;
  showBar?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  const titleId = useId();
  const Surface = embedded ? "section" : "main";
  const percent = typeof progress === "number"
    ? Math.round(Math.min(1, Math.max(0, progress)) * 100)
    : null;
  return (
    <Surface
      className={`initial-curtain${embedded ? " initial-curtain--embedded" : ""}`}
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
      aria-labelledby={titleId}
    >
      <AshAtlasBrandLogo className="initial-curtain__logo" />
      <span className="initial-curtain__wordmark">Ash Atlas</span>
      <div className="initial-curtain__status">
        <strong id={titleId}>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {!showBar ? null : percent === null ? (
        <div className="initial-curtain__bar" aria-hidden="true"><i /></div>
      ) : (
        <div
          className="initial-curtain__bar"
          data-determinate=""
          role="progressbar"
          aria-label={progressLabel ?? title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <i style={{ width: `${percent}%` }} />
        </div>
      )}
      {children}
    </Surface>
  );
}
