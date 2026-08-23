---
'react-canvas-ai': minor
---

Correct the hook internals: stale closures, listener churn and StrictMode double-firing.

**Added**

- `keyboardScope?: 'window' | 'container'` on `<MaskEditor />` and `useMaskEditor`, defaulting to `'window'`. `'container'` scopes undo/redo and the pan modifier keys to the focused editor, which is what you want with more than one editor on a page — by default a single `Ctrl+Z` undoes in all of them.

**Behaviour changes**

- `role="application"`, `tabIndex={0}` and the Space-swallowing key handler moved from `.react-mask-editor-outer` to `.react-mask-editor-inner`. The focusable element is now the container the editor measures, which is what `keyboardScope: 'container'` tests focus against. Restyle the focus ring through `.react-mask-editor-inner`.

- `onScaleChange` and `onPanChange` now fire synchronously inside the event that caused them, rather than on a deferred `setTimeout(0)`. `zoomToPoint` already reported synchronously, so the library is now consistent.
- `resetZoom()` issued right after `zoomIn()`/`zoomOut()` now wins. The zoom step used to schedule its transform write out of a state updater, letting the stale zoom overwrite the reset.
- Three-digit hex `maskColor` values are parsed correctly. `#fff` used to be read as `[255, 15]` and painted orange; non-hex input used to yield `NaN` channels that silently clamped to black.
- The base canvas no longer ships a `#f8f8f8` fill and a black 1px border under the image. These were debugging aids and were visible through any transparent region.
- `data-mask-editor-id` now comes from `useId()` instead of `Math.random()`, so server and client renders agree.

**Fixed**

- Two mask saves in the same tick desynced the history array from its index, silently corrupting undo. Reachable from a fast double stroke.
- Releasing the mouse at the end of a space-drag pan ended the stroke and pushed a history entry, because `handleMouseUp` read a stale `isPanning`.
- With two editors on a page, one taking the pan cursor clobbered the other's saved page cursor; the body cursor is now refcounted.
- Resizing the container after the image changed re-fitted the view to the previous image's dimensions.
- Changing `src` rapidly could let the superseded image win. Loads are now cancelled with an `AbortController`.
- Pending image-draw retries no longer fire after unmount; the retry ladder and its single-pixel "did the draw work" probe are gone. The probe reported failure for any image with a transparent centre pixel.
- Console diagnostics (`console.log` of CORS advice, draw breadcrumbs) are no longer emitted from the published build.

**Performance**

- The pan listeners were detached and re-attached on every `mousemove` during a drag; the cursor/brush listeners on every render; the wheel and keyboard listeners on every zoom step. All now attach once.
- `useMaskEditor`, `useZoomPan` and `useHistory` return memoized objects, so `MaskEditorProvider` no longer re-renders every consumer on every render.
- Changing `maxWidth`/`maxHeight` re-fits the image already in hand instead of refetching it.
