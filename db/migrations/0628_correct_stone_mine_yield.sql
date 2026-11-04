-- Correct the mine/reinforcement balance: one mine cycle yields one stone;
-- flag reinforcement continues to cost five stone in application authority.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'repeatable_resource_nodes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%yield_quantity = 5%'
  LOOP
    EXECUTE format(
      'ALTER TABLE repeatable_resource_nodes DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

UPDATE repeatable_resource_nodes
SET yield_item_id = 'stone',
    yield_quantity = 1
WHERE node_type = 'stone_mine'
  AND (yield_item_id <> 'stone' OR yield_quantity <> 1);

ALTER TABLE repeatable_resource_nodes
  ADD CONSTRAINT repeatable_resource_nodes_stone_mine_yield_check
  CHECK (node_type <> 'stone_mine' OR (yield_item_id = 'stone' AND yield_quantity = 1));
