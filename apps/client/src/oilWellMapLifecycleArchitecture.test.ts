import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("Oil Well map lifecycle", () => {
  it("reads construction through a ref so construction changes do not recreate the map", () => {
    const movementStart = app.indexOf("const requestLocalMovement = useCallback");
    const movementEnd = app.indexOf("const requestOpenCityWarehouse", movementStart);
    const movement = app.slice(movementStart, movementEnd);

    expect(movement).not.toContain("City construction is in progress");
  });

  it("does not move the camera when presenting active construction", () => {
    const markerStart = app.indexOf("if (!map || !activeCityConstruction) return;");
    const markerEnd = app.indexOf("useEffect(() =>", markerStart + 1);
    const markerEffect = app.slice(markerStart, markerEnd);

    expect(markerEffect).not.toMatch(/jumpTo|flyTo|easeTo|setCenter/);
  });

  it("exposes Tolls in the phone Game Menu destinations", () => {
    const destinationsStart = app.indexOf("const phoneDestinations");
    const destinationsEnd = app.indexOf("const mobileView", destinationsStart);
    const destinations = app.slice(destinationsStart, destinationsEnd);

    expect(destinations).toContain('{ id: "tolls" }');
  });
});
