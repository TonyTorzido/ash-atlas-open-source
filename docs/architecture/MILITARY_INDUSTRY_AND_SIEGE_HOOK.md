# Military Industry and Future Siege Hook

Military Industry V1 stops at durable production and a player-owned strategic
roster. It does not deploy, target, damage, or simulate siege engines.

The next siege slice must treat a future `field_ballista_kit` as a player-owned
condition-bearing item and perform one transaction:

1. Verify the player owns the kit and the Lodge still exists.
2. Lock the player's Lodge/personnel channel and the kit inventory row.
3. Verify the selected Siege Crew belongs to that player and is `available`.
4. Change that crew to `assigned`, incrementing its revision, and create the
   deployed Ballista record with the same player owner.
5. Consume or transform the kit atomically and commit the deployment.

Pack-up must return the condition-bearing kit and release the same crew to
`available` in one transaction. Destruction, wounded/recovery, targeting, HP,
ammunition, and warfare are intentionally left to that later slice.

The current production contract exposes `field_ballista_kit` only as an
explicitly future-gated job type (`fieldBallistaKitEnabled: false`); no item or
deployment action exists yet.
