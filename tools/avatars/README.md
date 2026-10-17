# Avatar assets

`web/avatars/*` is generated, and checked in. Nothing at runtime needs this
directory — the host and its tests stay dependency-free.

```bash
pip install pillow numpy
python3 tools/avatars/build_avatars.py     # writes web/avatars/
```

`3d/<shape>/<style>.png` holds one teal render per body and character, on
transparency. The builder splits each render into body, eyes, hair and the other
accessories, then writes one static face per body x character x colour, plus a
white-haired face for every character with hair:

- The body takes each palette colour under the render's own light, and the teal
  the render bounced onto hair and frames takes the new colour with it.
- The hair is told from frames and a headset band, which share its near-black, by
  shape: thick pieces above the eyes, grown back out to their tips. The headset
  band is fitted as an arch between the ear cups and kept out.
- White hair maps the hair's own light onto white, so its shine stays shine.
- On a black body, hair, frames and band lift evenly to charcoal and the eyes turn
  white, so nothing disappears into the face.

The console animates thinking and typing in CSS. `test/avatar.test.js` checks that
every face the picker can offer exists, and that `COLORS` here matches `COLORS` in
`web/avatar.js`. When the faces change, bump `AVATAR_BUILD` in `web/avatar.js` so
browsers fetch the new files.
