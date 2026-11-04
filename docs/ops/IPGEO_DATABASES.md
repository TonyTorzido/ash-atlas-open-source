# IP geolocation databases (mismatch signals)

The Settled mismatch signals (`NATIVE_ANTISPOOF_BUILD_PLAN.md` section 5) read the free
DB-IP Lite City and ASN databases (CC BY 4.0, <https://db-ip.com/db/lite.php>). The files are
large and are never committed. Without them the server logs one warning at boot and skips
every IP signal; timezone, carrier-country and static-GPS signals still run.

Attribution (keep in the app credits / wiki): "IP geolocation by DB-IP.com", CC BY 4.0.

## Install or update

```
node tools/trust/update-ipgeo.mjs            # current month, falls back to the previous one
node tools/trust/update-ipgeo.mjs --month 2026-10
```

It downloads `dbip-city-lite-YYYY-MM.mmdb.gz` and `dbip-asn-lite-YYYY-MM.mmdb.gz`, checks that
they gunzip and open, then swaps `dbip-city-lite.mmdb` and `dbip-asn-lite.mmdb` into
`TRUST_IPGEO_DIR` (default `apps/server/data/ipgeo`, gitignored) with atomic renames. The server
checks the file stamps every 10 minutes and reloads on its own; no restart or deploy is needed.

## VPS

- Set `TRUST_IPGEO_DIR` in `game.env` to a persistent absolute directory that deploys do not
  replace (the default sits inside the checkout / `dist/data`, which a deploy rewrites), for
  example `/var/lib/ash-atlas/ipgeo`. `tools/trust/update-ipgeo.mjs` reads the same variable.
- Run it once by hand after setting the variable, then monthly. DB-IP publishes on the first
  days of the month, so run it a few days in:

  ```
  # /etc/cron.d/ash-atlas-ipgeo  (3rd of each month, 04:17)
  17 4 3 * * ashatlas cd /srv/ash-atlas && TRUST_IPGEO_DIR=/var/lib/ash-atlas/ipgeo node tools/trust/update-ipgeo.mjs >> /var/log/ash-atlas-ipgeo.log 2>&1
  ```
- The City database is roughly 130 MB in memory per server process; the ASN one is small.
- Mode: `TRUST_MISMATCH_MODE=off|shadow|enforce` (default `shadow`). Only `enforce` revokes Settled
  (hard mismatch: 3 fixes in 24 h).
