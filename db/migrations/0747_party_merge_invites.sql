ALTER TABLE party_operations
  DROP CONSTRAINT IF EXISTS party_operations_action_check;

ALTER TABLE party_operations
  ADD CONSTRAINT party_operations_action_check CHECK (action IN (
    'create', 'invite', 'invite_to_party', 'accept', 'forward', 'decline', 'cancel',
    'remove', 'leave', 'change_leader', 'disband', 'set_travel_allowed',
    'set_auto_follow'
  ));
