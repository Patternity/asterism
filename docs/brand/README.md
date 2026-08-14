# Brand assets

`asterism-icon.svg` is the canonical mark. Everything else here is derived from
it; regenerate rather than edit the derivatives.

| File | Used by |
| --- | --- |
| `asterism-icon.svg` | source of truth |
| `asterism-icon-512.png` | raster fallback for contexts that reject SVG |
| `github-social-preview.png` | 1280×640 card for the repository's social preview |

The operations console serves its own copies from `control-plane/web/public/`:
`favicon.svg`, `favicon-32.png`, `favicon-192.png`, and `apple-touch-icon.png`.
They are referenced from `control-plane/web/index.html` and the shell renders the
SVG as the brand mark.

**The GitHub social preview must be uploaded by hand.** GitHub exposes no API for
it: open the repository's *Settings → General → Social preview* and upload
`github-social-preview.png`.
