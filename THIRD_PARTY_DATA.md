# Third-party data

Data sets shipped with, or derived into, Ash Atlas. Raw downloads are never committed; only the derived files listed here are.

## GHSL GHS-POP R2023A (population alert-zone grid)

- Used for: `apps/server/data/population-grid-v1.bin.gz` and `population-grid-v1.json`, a derived 0.05 degree grid of coarse population classes (red / orange / rural / urban) used by the server's relocation alert zones. Built by `tools/trust/build-population-grid.mjs`.
- Source: GHS-POP R2023A, 30 arc-second, epoch 2025, WGS84 (EPSG:4326), `GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0`, European Commission, Joint Research Centre (JRC), Global Human Settlement Layer: https://ghsl.jrc.ec.europa.eu/
- Citation: Schiavina M., Freire S., Carioli A., MacManus K. (2023). GHS-POP R2023A - GHS population grid multitemporal (1975-2030). European Commission, JRC. doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE
- License: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- Changes: resampled to 0.05 degree cells, summed over each cell and its 8 neighbours, and reduced to four classes. The derived grid contains no per-person data and cannot be inverted to the source raster.

## DB-IP Lite City and ASN (IP geolocation for mismatch signals)

- Used for: server-side ASN class, country and rounded-area lookups from the player's IP address (`apps/server/src/auth/trust/ipGeo.ts`). The databases are downloaded by `tools/trust/update-ipgeo.mjs`, are never committed, and no IP is sent to DB-IP. Raw IPs are not stored in trust records.
- Source: IP Geolocation by DB-IP, https://db-ip.com (DB-IP Lite City and ASN databases).
- License: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/. The license requires attribution; the in-game credit (Menu, About, Credits) reads "IP geolocation by DB-IP.com" with a link to https://db-ip.com. The GHSL credit sits in the same place.
- Changes: none to the databases; only country, ASN and rounded city coordinates are read.
