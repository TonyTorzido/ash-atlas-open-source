ALTER TABLE account_dogs
  ALTER COLUMN current_stamina_seconds TYPE double precision
  USING current_stamina_seconds::double precision;
