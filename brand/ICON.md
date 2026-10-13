# Sunday Run Club icon

The mark is a **running shoe in motion beneath a rising Sunday sun**: a half
sun with five round rays over a horizon line, and a side-view running shoe
with two speed lines behind the heel and two lace notches on the instep.
Flat, no text, no gradients, shadows or outlines.

**Colours:** the Homeroom brand pairing **Cream `#FFFEEA` + Black
`#000000`** only. Every pixel lies on the blend line between the two;
anti-aliased
edges blend them, nothing else is coloured.

**Sources** (SVG, committed so the mark can be redrawn):

| File | Size | Pairing |
| --- | --- | --- |
| `icon.svg` / `icon.png` | 1024 × 1024 | black mark on cream |
| `featured-light.svg` / `featured-light.png` | 1600 × 900 | black mark on cream |
| `featured-dark.svg` / `featured-dark.png` | 1600 × 900 | cream mark on black |

The featured artwork is the same mark at 0.62 scale, centred, with the
horizon line extended (x 160–1440) and the speed lines about twice as long.
The light and dark versions have identical geometry with the colours swapped.

`icon.png` is declared in `dapp.json` as `icon.image` (with the original 👟
emoji kept as the fallback). The platform reads it at deploy, fills the
rounded home-screen tile with it and crops to the tile's corners — the PNG
is full-bleed with square corners and the mark keeps clear of the corners.

**The featured files are not wired into anything yet:** the platform has no
`dapp.json` field for featured directory artwork. They are kept here, ready
for whoever features the app; the light version suits a light directory
surface, the dark version a dark one.

**How the PNGs were rendered:** each SVG was opened in a browser at a
viewport exactly its image size (device scale 1) and captured as a
full-viewport screenshot — opaque RGB PNGs, square corners, no alpha
channel. `icon.png` is about 18 KB, well under the platform's 256 KB limit.
