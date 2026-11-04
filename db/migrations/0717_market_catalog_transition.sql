-- Food and Ore remain valid inventory resources, but leave the fungible market
-- catalog. Existing orders keep their durable identity and remain visible to
-- their owners so the existing cancellation path can return escrow safely.
UPDATE item_definitions
SET market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    updated_at = now()
WHERE item_id IN ('food', 'ore');
