# Player appearance assets

This directory contains transparent PNGs used on layered world players. Assets are imported
through Appearance Studio and referenced by normalized paths in
`packages/shared/src/data/player-appearance-catalog.json`.

Supported categories are `bodies`, `weapons`, `armor/head`, `armor/chest`, `armor/gloves`,
`armor/boots`, `shields`, `enhancements/gems`, `cosmetics`, and `salon`. Inventory icons are
deliberately separate.

The canonical player base uses one transparent whole-player template below equipment. Appearance
Studio stores one Base Body / Player Base asset per pose plus exactly three linked skin-tone slots
(Light, Medium, Dark). Tone assets reuse the base pose transforms, rig anchors, and frame layout;
an unfilled tone link falls back to the base asset. The renderer retains the head and face-accessory
layers for hair, face, mask, and Beard overlays. Every attachment anchor can be positioned directly
for each pose.
