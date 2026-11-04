import { createRoot } from "react-dom/client";

import { WorldMapEnvironmentalOverlayStory } from "./WorldMapEnvironmentalOverlayStory.js";

const smokeStartedAt = performance.now();
const layout = new URLSearchParams(window.location.search).get("layout") === "phone"
  ? "phone"
  : "desktop";
document.documentElement.dataset.uiProfile = layout;
const rootElement = document.getElementById("root")!;
const recordOverlayResources = (): void => {
  const resources = performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("world-environment-overlays"));
  rootElement.dataset.overlayResourceCount = String(resources.length);
  rootElement.dataset.overlayResourceMaxDurationMs = String(
    Math.max(0, ...resources.map((entry) => entry.duration)).toFixed(2)
  );
};
new PerformanceObserver(recordOverlayResources).observe({ type: "resource", buffered: true });
document.addEventListener("change", () => {
  const startedAt = performance.now();
  requestAnimationFrame(() => {
    rootElement.dataset.lastToggleFrameMs = (performance.now() - startedAt).toFixed(2);
  });
});

createRoot(rootElement).render(<WorldMapEnvironmentalOverlayStory layout={layout} />);
requestAnimationFrame(() => requestAnimationFrame(() => {
  rootElement.dataset.initialRenderMs = (performance.now() - smokeStartedAt).toFixed(2);
}));
