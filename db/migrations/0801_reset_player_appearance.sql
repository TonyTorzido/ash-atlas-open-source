UPDATE players
SET hair_appearance_id = 'blonde-hair-1',
    eyes_appearance_id = 'blue-eyes-1',
    mask_appearance_id = NULL,
    legs_overlay_appearance_id = 'cloth-pants-black',
    base_appearance_revision = base_appearance_revision + 1
WHERE hair_appearance_id IS DISTINCT FROM 'blonde-hair-1'
   OR eyes_appearance_id IS DISTINCT FROM 'blue-eyes-1'
   OR mask_appearance_id IS DISTINCT FROM NULL
   OR legs_overlay_appearance_id IS DISTINCT FROM 'cloth-pants-black';
