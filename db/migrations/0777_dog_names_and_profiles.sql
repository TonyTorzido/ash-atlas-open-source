ALTER TABLE account_dogs
  DROP CONSTRAINT IF EXISTS account_dogs_name_check,
  DROP CONSTRAINT IF EXISTS account_dogs_name_gender;

ALTER TABLE account_dogs
  ADD COLUMN favorite_food text,
  ADD COLUMN fun_fact text;

WITH profile AS (
  SELECT id,
    (ARRAY['Pickles','Chicken','Cheese','Carrots','Peanut Butter','Apples'])[
      (1 + (('x' || substr(md5(id::text || ':favorite-food'), 1, 8))::bit(32)::bigint % 6))::integer
    ] AS favorite_food,
    (ARRAY[
      'Dreams about chasing clouds.',
      'Can hear a treat bag from three rooms away.',
      'Always chooses the sunniest nap spot.',
      'Wiggles from nose to tail when excited.',
      'Carries the same favorite stick everywhere.',
      'Thinks every visitor came just to say hello.'
    ])[(1 + (('x' || substr(md5(id::text || ':fun-fact'), 1, 8))::bit(32)::bigint % 6))::integer] AS fun_fact
  FROM account_dogs
)
UPDATE account_dogs AS dogs
SET favorite_food = profile.favorite_food,
    fun_fact = profile.fun_fact
FROM profile
WHERE dogs.id = profile.id;

ALTER TABLE account_dogs
  ALTER COLUMN favorite_food SET NOT NULL,
  ALTER COLUMN fun_fact SET NOT NULL,
  ADD CONSTRAINT account_dogs_name_safe CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 24
    AND name !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT account_dogs_favorite_food_safe CHECK (
    favorite_food = btrim(favorite_food)
    AND char_length(favorite_food) BETWEEN 1 AND 80
    AND favorite_food !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT account_dogs_fun_fact_safe CHECK (
    fun_fact = btrim(fun_fact)
    AND char_length(fun_fact) BETWEEN 1 AND 160
    AND fun_fact !~ '[[:cntrl:]]'
  );
