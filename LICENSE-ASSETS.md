# Asset and documentation license

Unless noted below, all art, images, sprites, audio, music, and documentation in this
repository are licensed under the Creative Commons Attribution 4.0 International license
(CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

Attribution line: **Ash Atlas by TonyTorzido**

## Summary (not a substitute for the license)

You are free to:

- **Share**: copy and redistribute the material in any medium or format, for any purpose,
  including commercially.
- **Adapt**: remix, transform, and build upon the material for any purpose, including
  commercially.

Under these terms:

- **Attribution**: you must give appropriate credit, provide a link to the license, and
  indicate if changes were made. You may do so in any reasonable manner, but not in any way
  that suggests the licensor endorses you or your use.
- **No additional restrictions**: you may not apply legal terms or technological measures that
  legally restrict others from doing anything the license permits.

## Exceptions

| Material | License |
| --- | --- |
| Cinzel font (`apps/client/src/wiki/fonts/`) | SIL Open Font License 1.1 (see `apps/client/src/wiki/fonts/OFL.txt`) |
| Gradle wrapper (`android/gradle/wrapper/`) | Apache License 2.0 |
| Population grid data (`apps/server/data/population-grid-v1.*`) | CC BY 4.0, derived from GHS-POP R2023A (see `THIRD_PARTY_DATA.md`) |
| Game Menu glyphs (`apps/client/src/ui/MenuDestinationGlyph.tsx`) | Phosphor Icons "duotone", MIT License (see notice below) |

Source code is licensed separately under the MIT License (see `LICENSE`).

## Third-party notices

**Phosphor Icons** (MIT License) - Copyright (c) 2023 Phosphor Icons, https://phosphoricons.com.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: the above copyright notice and this
permission notice shall be included in all copies or substantial portions of the Software. THE
SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

**Map data and tiles.** The client can display OpenStreetMap raster tiles (the default tile URL is
in `apps/client/src/config.ts`). Map data (c) OpenStreetMap contributors, available under the Open
Database License: https://www.openstreetmap.org/copyright. Keep this attribution visible in any
build that shows those tiles, and review the tile server usage policy before running a public
service (the default OSM tile server is not intended for production traffic).

**Natural Earth.** The World Map country overview uses Natural Earth public-domain map data:
https://www.naturalearthdata.com/about/terms-of-use/

**Other data.** GHSL GHS-POP and DB-IP Lite attributions are in `THIRD_PARTY_DATA.md`.

**Provenance.** The CC BY 4.0 grant above covers only material the author had the right to
license. Third-party marks (for example Google or Apple sign-in branding) remain the property of
their owners and are not licensed by this repository.
