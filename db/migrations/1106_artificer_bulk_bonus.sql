-- Artificer (Crafter) bulk bonus: +1 item per 6 (rank 3-4) or per 4 (rank 5) crafted.
-- The bonus is recorded on the job at start time and folded into output_quantity, so collection,
-- replay and the collected<=output guards stay unchanged. The recipe-exact output checks now apply
-- to the base output (output_quantity - bonus_quantity).
ALTER TABLE kitchen_jobs ADD COLUMN IF NOT EXISTS bonus_quantity integer NOT NULL DEFAULT 0 CHECK (bonus_quantity >= 0);
ALTER TABLE loom_jobs ADD COLUMN IF NOT EXISTS bonus_quantity integer NOT NULL DEFAULT 0 CHECK (bonus_quantity >= 0);
ALTER TABLE tannery_jobs ADD COLUMN IF NOT EXISTS bonus_quantity integer NOT NULL DEFAULT 0 CHECK (bonus_quantity >= 0);

ALTER TABLE loom_jobs DROP CONSTRAINT IF EXISTS loom_jobs_output_quantity_check;
ALTER TABLE loom_jobs
  ADD CONSTRAINT loom_jobs_output_quantity_check
    CHECK (
      output_quantity BETWEEN 1 AND 1000
      AND bonus_quantity < output_quantity
      AND (recipe_id <> 'flax_fiber' OR (output_quantity - bonus_quantity) * 2 = requested_input_quantity)
    );

ALTER TABLE kitchen_jobs DROP CONSTRAINT IF EXISTS kitchen_jobs_output_quantity_check;
ALTER TABLE kitchen_jobs
  ADD CONSTRAINT kitchen_jobs_output_quantity_check
    CHECK (
      output_quantity BETWEEN 1 AND 1000
      AND bonus_quantity < output_quantity
      AND (recipe_id NOT IN (
        'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat', 'alligator_meat',
        'wild_meat', 'squid_meat', 'freshwater_fish'
      ) OR (output_quantity - bonus_quantity) * 10 = requested_input_quantity)
    );

-- Merchant trade-post tax reduction: a trade's buyer fee must equal an immutable fee-policy snapshot
-- (settlement triggers compare applied_buyer_tax_bps to the policy), so each reduced buyer tax is a policy.
-- Standard 900 bps -> 828/720/540 and specialty 450 bps -> 414/360/270 at Merchant ranks 2/4/5.
-- Orders keep policy 2/3 for escrow reserves; only the trade-level buyer snapshot uses these.
INSERT INTO market_fee_policies (
  fee_policy_id, version, listing_fee, buyer_fee_bps, seller_fee_bps, cancellation_fee, active
) VALUES
  (41, 4101, 0, 828, 0, 0, true),
  (42, 4201, 0, 720, 0, 0, true),
  (43, 4301, 0, 540, 0, 0, true),
  (44, 4401, 0, 414, 0, 0, true),
  (45, 4501, 0, 360, 0, 0, true),
  (46, 4601, 0, 270, 0, 0, true)
ON CONFLICT (fee_policy_id) DO NOTHING;
