# Greenmole mascot artwork

The Greenmole mark is an original cute green mole mascot with a rosy nose,
light muzzle and little digging paws. It replaces the earlier geometric G mark.
It is not derived from the Apache Guacamole logo. These project assets are
distributed under the repository's [Apache License 2.0](../LICENSE); existing
Apache attribution and third-party notices remain unchanged.

## Assets

- [Original transparent PNG](../client/guacamole/src/main/frontend/src/images/greenmole.png), 1254×1254 pixels.
- [Login and README image](../client/guacamole/src/main/frontend/src/images/greenmole-256.png), 256×256 pixels.
- [Small favicon](../client/guacamole/src/main/frontend/src/images/greenmole-64.png), 64×64 pixels.
- [Large and touch icon](../client/guacamole/src/main/frontend/src/images/greenmole-144.png), 144×144 pixels.

The original was created using the built-in image generation tool with a
transparent background. Standard icon resizing preserves its alpha channel.
No generated asset is referenced outside this repository.

## Generation prompt

> Use case: logo-brand. Create an original cute green mole (the burrowing animal) mascot logo for the Greenmole remote desktop application. One compact centered animal, head and upper body with two little broad digging paws visible. A plump rounded forest-green body, lighter mint-green muzzle and belly, tiny friendly dark eyes, a small rosy pink nose on a gently pointed mole snout, a subtle happy smile, short cream-colored claws. Recognizably a mole, not a bear or mouse: no large visible ears, no buck teeth. Warm, sweet, approachable personality. Polished flat vector-like illustration with bold simple shapes, soft rounded corners and a restrained dark-green outline; very little detail so it is recognizable as a 64px favicon. Square composition, animal occupies most of the canvas with a small safe margin, entirely visible and isolated on genuine transparent background. No letters, words, badges, circles, background scene, soil mound, props, watermark, or existing brand symbols. This is the primary production logo, not a mockup or contact sheet.

## Rebuild the derived icons

On macOS, run from the repository root:

```sh
sips -z 64 64 client/guacamole/src/main/frontend/src/images/greenmole.png --out client/guacamole/src/main/frontend/src/images/greenmole-64.png
sips -z 144 144 client/guacamole/src/main/frontend/src/images/greenmole.png --out client/guacamole/src/main/frontend/src/images/greenmole-144.png
sips -z 256 256 client/guacamole/src/main/frontend/src/images/greenmole.png --out client/guacamole/src/main/frontend/src/images/greenmole-256.png
```

Original PNG SHA-256: `5c1cb410e7f474ad971f29cfd09895d1413a58abbe9cb038c1afd1e38a6729a7`.
