import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("City Warehouse session architecture", () => {
  it("routes map selection, world-target, City App, and build openings through one interaction and session helper", () => {
    expect(app).toContain("setSelectedCityStructure(target.value);");
    expect(app).toContain("setSelectedCityStructure(pickedCityStructure);");
    expect(app).toContain('onSelect: () => requestOpenCityWarehouse(selectedCityStructure, "world")');
    expect(app).toMatch(/onOpenWarehouse=\{\(structure\) =>\s*requestOpenCityWarehouse\(structure, "city"\)\}/);
    expect(app).toContain('requestOpenCityWarehouse(cityWarehouseStructure, "build")');
    expect(app).toContain("const requestOpenCityWarehouse = useCallback((");
    expect(app).toContain("openCityWarehouseNow(structure);");
    expect(app).toContain("openCityWarehouseNow(current);");
    expect(app).toMatch(/const openCityWarehouseNow = useCallback\([\s\S]*?beginCityWarehouseSession\(structure.structureId\);/);
    expect(app.match(/beginCityWarehouseSession\(structure.structureId\);/gu)).toHaveLength(1);
    expect(app).not.toContain("clientRef.current?.openCityWarehouse");
  });

  it("closes the phone Build destination before city build confirmations", () => {
    expect(app).toMatch(
      /const requestPhoneCityConstruction = useCallback\([\s\S]*?mobileMenuNavigation\.close\(\);[\s\S]*?cityConstruction\.actions\.requestBuild\(action\)/
    );
    const buildOptions = app.slice(
      app.indexOf("const phoneBuildOptions"),
      app.indexOf("const closeUtilityPanels")
    );
    expect(buildOptions.match(/requestPhoneCityConstruction\(\{/g)).toHaveLength(10);
    expect(buildOptions.match(/cityConstruction\.actions\.requestBuild\(\{/g)).toHaveLength(1);
  });
});
