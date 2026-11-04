import type { ReactNode } from "react";

import { AshAtlasBrandLogo } from "./ui/AshAtlasBrandLogo.js";
import { useUiEnvironment } from "./uiEnvironment.js";

export function PresentationShell({ children }: { children: ReactNode }): React.JSX.Element {
  const { inputMode, layoutMode, presentation } = useUiEnvironment();
  const wide = layoutMode === "wide";
  return (
    <div
      className="app-presentation"
      data-gameplay-layout={layoutMode}
      data-input-mode={inputMode}
      data-layout-component="PresentationShell"
    >
      {wide && presentation === "touch" ? (
        <aside className="desktop-shell-branding" aria-label="Ash Atlas desktop preview">
          <AshAtlasBrandLogo className="desktop-shell-brand-logo" />
          <strong>Ash Atlas</strong>
          <span>Touch presentation</span>
          <p>Explore the atlas with touch-ready controls.</p>
        </aside>
      ) : null}
      <div
        className="mobile-app-stage"
        data-testid="mobile-app-stage"
        data-gameplay-ui={wide ? "canonical-wide" : "canonical-compact"}
      >
        {children}
      </div>
    </div>
  );
}
