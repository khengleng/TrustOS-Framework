# Brand assets

These files are served from `/brand/…` by the portal and ship inside the runtime image —
`useStaticAssets` points at `public/`, and the Dockerfile copies `apps/`. So anything added
here reaches a deployed environment, unlike anything under `docs/`.

## Expected files

| File       | Used for                                   | Notes                                      |
| ---------- | ------------------------------------------ | ------------------------------------------ |
| `icon.png` | portal header mark, browser tab icon       | square, 512×512, transparent background    |
| `logo.png` | wider lockup — README, sign-in panel       | mark plus the TRUSTSYSTEM wordmark         |
| `icon.svg` | preferred over `icon.png` wherever present | scalable; sharper in a tab and at any zoom |

## Until they exist

The portal degrades on purpose rather than showing a broken image: `.mark` in `portal.css`
paints the accent colour underneath the background image, so a missing `icon.png` renders as
the plain accent square the portal used before. The tab icon keeps its inline shield until an
`icon.png` is added.

Nothing here is generated. These are supplied artwork, and a placeholder invented in code
would be worse than an honest square.
