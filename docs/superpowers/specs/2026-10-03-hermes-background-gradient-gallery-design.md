# Hermes Background Gradient Gallery — Design Spec

## Goal

Create a scrollable, background-only visual gallery at `https://hermes.trynava.io/designs/background-gradient-gallery.html`. It presents every one of the 26 gradient components in OpenSourceUI's Background Gradient category as a wide, text-free swatch, using the uploaded NAVA artwork only as visual inspiration: a broad landscape canvas, atmospheric color blooms, and soft edge depth. Do not reproduce its wordmark or tagline.

## Visual direction

- Treat the reference's 722×335 image as the sample proportion (`722 / 335`). Preserve its broad central glow and softly blended atmosphere, but let each catalog entry retain its own color family and signature geometry so the 26 choices remain visibly distinct.
- Keep the page itself quiet: a near-black teal surround, generous gutters, and three swatches per desktop row. Do not add a site header, logo, visible title, labels, controls, or explanatory copy.
- Use the source component name only as each swatch's accessible name (`role="img"`, `aria-label`). This makes the gallery navigable without adding visible text to the artwork.
- Flow 3 columns at desktop, 2 at tablet, and 1 on narrow phones. The document scrolls vertically through all 26 samples; it has no fixed-height viewport or horizontal scroller.
- Keep each swatch at `aspect-ratio: 722 / 335`, with a subtle consistent edge treatment that does not obscure the gradients.

## Catalog mapping

All 26 entries below are required, in the listed order. The names and links are from [OpenSourceUI — Background Gradient](https://opensourceui.in/components/category/background-gradient). Recreate the described visual mechanics with original CSS; do not copy component source.

| # | Component / source | Signature treatment |
|---:|---|---|
| 1 | [Arc Bands](https://opensourceui.in/components/arc-bands-background) | Three broad, bottom-centered retro arcs in sky, teal, amber, and rose on warm paper. |
| 2 | [Aurora Background](https://opensourceui.in/components/aurora-background) | Four soft lime, mint, cyan, and blue aurora pools. |
| 3 | [Cherry Petal](https://opensourceui.in/components/cherry-petal-background) | Seven still, rotated petal forms and a blush glow on spring pink. |
| 4 | [Coral Glow](https://opensourceui.in/components/coral-glow-background) | Four warm rose, peach, coral, and gold glow pools. |
| 5 | [Dark Arc Bands](https://opensourceui.in/components/dark-arc-bands-background) | Three subdued bottom-centered sky, teal, amber, and rose arcs on midnight. |
| 6 | [Dark Aurora](https://opensourceui.in/components/dark-aurora-background) | Four heavily softened teal, cyan, emerald, and sky pools on charcoal. |
| 7 | [Dark Carbon Spotlight](https://opensourceui.in/components/dark-carbon-spotlight-background) | Overhead white spotlight on carbon black with a strong vignette. |
| 8 | [Dark Ember](https://opensourceui.in/components/dark-ember-background) | Four amber, orange, and rose light pools on deep brown-black. |
| 9 | [Dark Ink Field](https://opensourceui.in/components/dark-ink-field-background) | Three asymmetrically rounded graphite ink washes on near-black. |
| 10 | [Dark Midnight Mesh](https://opensourceui.in/components/dark-midnight-mesh-background) | Fine dual grid, teal/sky corner blooms, and dark vignette. |
| 11 | [Dark Rose Noir](https://opensourceui.in/components/dark-rose-noir-background) | Muted rose and crimson blooms with a dark noir vignette. |
| 12 | [Dark Teal Depth](https://opensourceui.in/components/dark-teal-depth-background) | Broad teal/cyan ocean-depth blooms on deep blue-black. |
| 13 | [Frost Mesh](https://opensourceui.in/components/frost-mesh-background) | Pale frost mesh with cyan and emerald corner washes. |
| 14 | [Halftone Pop](https://opensourceui.in/components/halftone-pop-background) | Three rose, teal, and amber risograph dot fields on cream. |
| 15 | [Honey Ember](https://opensourceui.in/components/honey-ember-background) | Honey, amber, ember-orange, and soft-rose pools on ivory. |
| 16 | [Ink Wash](https://opensourceui.in/components/ink-wash-background) | Four soft, irregular gray sumi-e clouds on warm paper. |
| 17 | [Linen Weave](https://opensourceui.in/components/linen-weave-background) | Warm ivory/tan paper with subtle woven crosshatch and vignette. |
| 18 | [Mint Lagoon](https://opensourceui.in/components/mint-lagoon-background) | Emerald, teal, cyan, and mint aurora on cool white. |
| 19 | [Paper Fold](https://opensourceui.in/components/paper-fold-background) | A quiet diagonal paper crease, highlight, shadow, and fine grid. |
| 20 | [Rain Prism](https://opensourceui.in/components/rain-prism-background) | Fine angled rain strokes with a soft teal/rose/sky prism band. |
| 21 | [Sand Drift](https://opensourceui.in/components/sand-drift-background) | Layered stone/amber dune arcs, pale upper wash, and fine grain. |
| 22 | [Soft Spotlight](https://opensourceui.in/components/soft-spotlight-background) | Soft gallery light from above on warm gray with a gentle vignette. |
| 23 | [Sunrise Horizon](https://opensourceui.in/components/sunrise-horizon-background) | Peach dawn bands, a low sun glow, and a muted teal lift. |
| 24 | [Sunset Bloom](https://opensourceui.in/components/sunset-bloom-background) | Golden-hour orange, rose, amber, and sun-yellow glow pools. |
| 25 | [Terrazzo Fragment](https://opensourceui.in/components/terrazzo-fragment-background) | Ten scattered, softly rotated stone, rose, teal, amber, and clay chips. |
| 26 | [Tropical Tide](https://opensourceui.in/components/tropical-tide-background) | Bright turquoise, lime, sky-blue, and sea-green pools. |

## Implementation boundaries

- The canonical deliverable is one self-contained HTML file: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`.
- Use native HTML and CSS only. No JavaScript, external fonts, scripts, images, network requests, build step, or runtime dependency.
- Make each sample a separate element with a unique `data-gradient` matching its exact catalog slug and accessible label matching its title.
- The live static root is `/home/orca/.gstack/projects/zero/designs/current-ui-showcase`; Caddy already maps `/designs/*` to its existing static server. Deployment adds only `background-gradient-gallery.html` there.
- Do not edit or replace `index.html`, `outlook-side-pane-demo.html`, `quote-rate-proof.png`, other served files, Caddy configuration, or any application/service configuration.

## Acceptance criteria

1. Exactly 26 unique swatches appear in catalog order with all component names exposed to assistive technology.
2. The page has no visible text or branding; the image's `NAVA` mark and `Autonomous Agents for Big Insurance` tagline are absent.
3. Desktop/tablet/phone layouts use 3/2/1 columns respectively, preserve the 722:335 swatch ratio, and scroll vertically without page-level horizontal overflow.
4. The page makes no network requests and requires no JavaScript or external assets.
5. The deployed route returns HTTP 200, and its bytes match the reviewed canonical HTML source.
6. Existing live demo, index, and image hashes remain unchanged.
