-- User-authorized one-time reset of the current Dog system for all accounts.
TRUNCATE TABLE
  dog_events,
  dog_boardings,
  dog_foundation_purchases,
  dog_breeding_contracts,
  dog_traits,
  dog_explore_destinations,
  dog_daily_care,
  account_dogs,
  dog_owner_cooldowns
RESTART IDENTITY;
