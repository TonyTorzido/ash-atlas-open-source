-- Preserve the historical constraint identity expected by populated upgrades while
-- retaining the area-aware rule introduced in the preceding migration.

ALTER TABLE collectible_nodes
  RENAME CONSTRAINT collectible_nodes_environment_generation_complete
  TO collectible_nodes_flag_generation_complete;
