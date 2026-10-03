# Hermes Background Gradient Gallery — Image-Locked Design Spec

## Goal

Rework the gallery at `https://hermes.trynava.io/designs/background-gradient-gallery.html` so all 26 OpenSourceUI background treatments reinterpret the background in the user-provided NAVA image. The image is the visual source of truth: preserve its teal field, central violet bloom, lower-left magenta-violet wash, blue lower lift, dark teal edges, and wide 722×334 composition. Remove the NAVA wordmark and tagline completely.

## Visual direction

- Every tile uses the same image-derived palette and the same underlying composition. Only the geometry, texture, and placement of the OpenSourceUI treatment varies. Do not carry over the catalog pages' unrelated cream, lime, amber, coral, red, or bright-green palettes.
- Sampled background-only pixels in the uploaded PNG include `#113f3f` (upper-left field), `#13454c` (teal field), `#35598d` / `#41699a` (blue lower field), `#6a5bb1` (indigo), `#986bcd` (central violet bloom), and `#a566d1` / `#ac6ed7` (lower-left magenta-violet bloom). Use these as the shared color tokens; derive translucent accents only from these colors.
- Preserve the image's broad dark-teal surround and edge falloff, a soft violet bloom around the upper-middle center, a magenta-violet bloom entering from the lower left, and blue-violet color through the lower center. A treatment may add its signature form, but it must not erase that composition or introduce another color family.
- Present three samples side by side on desktop, two on tablet, and one on a narrow phone. Keep the page in normal vertical flow so the user can scroll through all 26.
- Each artwork tile is exactly `aspect-ratio: 722 / 334`, matching the uploaded PNG's actual IHDR dimensions.
- Add each official component name as a compact caption below its artwork, outside the background itself, so the user can identify their favorite. No NAVA text, logos, title overlays, controls, or decorative copy.

## Catalog mapping

The 26 titles, slugs, order, and source links come from [OpenSourceUI — Background Gradient](https://opensourceui.in/components/category/background-gradient). Recreate each treatment's geometry using original CSS; the source pages inform shape and texture only, not colors. Do not copy their CSS or markup verbatim.

| # | Component / source | Geometry or texture to vary (palette stays locked) |
|---:|---|---|
| 1 | [Arc Bands](https://opensourceui.in/components/arc-bands-background) | Broad concentric, bottom-centered arcs. |
| 2 | [Aurora Background](https://opensourceui.in/components/aurora-background) | Soft, interleaving aurora pools. |
| 3 | [Cherry Petal](https://opensourceui.in/components/cherry-petal-background) | A still scatter of translucent petal shapes. |
| 4 | [Coral Glow](https://opensourceui.in/components/coral-glow-background) | Four soft, overlapping glow pools. |
| 5 | [Dark Arc Bands](https://opensourceui.in/components/dark-arc-bands-background) | Lower-contrast concentric arcs with deeper teal edges. |
| 6 | [Dark Aurora](https://opensourceui.in/components/dark-aurora-background) | Low-opacity, heavily softened aurora pools. |
| 7 | [Dark Carbon Spotlight](https://opensourceui.in/components/dark-carbon-spotlight-background) | Overhead spotlight with a pronounced edge vignette. |
| 8 | [Dark Ember](https://opensourceui.in/components/dark-ember-background) | Four subdued glow pools. |
| 9 | [Dark Ink Field](https://opensourceui.in/components/dark-ink-field-background) | Asymmetrically rounded, blurred organic washes. |
| 10 | [Dark Midnight Mesh](https://opensourceui.in/components/dark-midnight-mesh-background) | Fine dual grid, corner blooms, and vignette. |
| 11 | [Dark Rose Noir](https://opensourceui.in/components/dark-rose-noir-background) | Magenta-violet blooms with a dark edge falloff. |
| 12 | [Dark Teal Depth](https://opensourceui.in/components/dark-teal-depth-background) | Broad, layered teal depth pools. |
| 13 | [Frost Mesh](https://opensourceui.in/components/frost-mesh-background) | Fine mesh overlay with softly washed corners. |
| 14 | [Halftone Pop](https://opensourceui.in/components/halftone-pop-background) | Sparse halftone dot fields. |
| 15 | [Honey Ember](https://opensourceui.in/components/honey-ember-background) | Distributed, overlapping glow pools. |
| 16 | [Ink Wash](https://opensourceui.in/components/ink-wash-background) | Irregular, soft-edged ink-cloud forms. |
| 17 | [Linen Weave](https://opensourceui.in/components/linen-weave-background) | Subtle woven crosshatch. |
| 18 | [Mint Lagoon](https://opensourceui.in/components/mint-lagoon-background) | Flowing, softened aurora ribbons. |
| 19 | [Paper Fold](https://opensourceui.in/components/paper-fold-background) | A diagonal crease and restrained fine grid. |
| 20 | [Rain Prism](https://opensourceui.in/components/rain-prism-background) | Angled rain streaks and a soft horizontal prism band. |
| 21 | [Sand Drift](https://opensourceui.in/components/sand-drift-background) | Layered bottom-centered dune arcs and fine grain. |
| 22 | [Soft Spotlight](https://opensourceui.in/components/soft-spotlight-background) | A soft overhead spotlight and gentle vignette. |
| 23 | [Sunrise Horizon](https://opensourceui.in/components/sunrise-horizon-background) | Horizontal bands and a low centered glow. |
| 24 | [Sunset Bloom](https://opensourceui.in/components/sunset-bloom-background) | Large, overlapping multi-point blooms. |
| 25 | [Terrazzo Fragment](https://opensourceui.in/components/terrazzo-fragment-background) | Scattered, softly rotated fragments. |
| 26 | [Tropical Tide](https://opensourceui.in/components/tropical-tide-background) | Broad, overlapping tide-like pools. |

## Implementation boundaries

- Canonical page: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`.
- Keep it standalone: HTML and CSS only; no scripts, network requests, external fonts/assets, dependencies, or build step.
- Every sample pairs one unique catalog slug with the matching accessible name and visible caption. The caption stays outside the artwork tile.
- The live page is served by the existing static route `/designs/*`; update only `background-gradient-gallery.html` in that directory. Do not edit the Outlook demo, index, screenshot assets, Caddy config, app, or service.
- The 26 signature treatments are original CSS geometry/texture using the shared image palette. No source component's native palette is retained.

## Acceptance criteria

1. All 26 official entries appear once, in source order, with exact titles, slugs, accessible names, and captions.
2. Every artwork uses the same sampled teal/blue/violet/magenta palette and retains the same broad image composition; per-entry differences come from treatment geometry or texture only.
3. No NAVA wordmark, tagline, logo, or text appears inside any artwork; only component-name captions appear outside tiles.
4. Desktop/tablet/phone layouts are 3/2/1 columns, with exact 722:334 tile ratio and vertical scrolling without horizontal overflow.
5. The page is self-contained and produces no network requests.
6. Chromium screenshots at desktop, tablet, and phone widths visually match the palette and composition above, while showing distinguishable treatments.
7. The live route returns HTTP 200 and its response bytes match the reviewed canonical page.
8. Existing served Outlook demo, index, and image retain their recorded SHA-256 values.
