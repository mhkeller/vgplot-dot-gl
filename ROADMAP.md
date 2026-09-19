# Roadmap

Known work that isn't done yet.

## Zoom frames count dots that are off screen

`estimateFragments` in `src/painters/gl.js` counts every uploaded dot, including the ones outside the frame. Zoomed far into a dense plot, the estimate goes over `fragmentBudget` even when few dots are on screen, so zoom frames draw blurrier than they need to.

Fix: estimate from the share of the data range that is on screen (the scale domain against `prep.extent`), or from how many dots the last frame drew inside the frame.

## Zoom frames never drop below pixel ratio 1

Reduced zoom frames stop at pixel ratio 1 (`MIN_REDUCED_DPR` in `src/painters/gl.js`). On a 1x screen, or at 2M+ rows with large dots, a zoom frame still paints hundreds of millions of pixels.

Fix: measure frames per second at 2M+ rows with `MIN_REDUCED_DPR` at 1 and at 0.5. If 0.5 is clearly faster, use it.

## Copying the picture into each plot waits for the graphics card

`blitTo` in `src/shared-gl.js` copies the shared WebGL canvas into each plot with `drawImage`, and that call waits for the graphics card to finish the frame. When a brush redraws several plots at once, each copy waits in turn.

Fix: first read `mark.stats.blitMs` with `benchmark` off on a page with many plots. If it reads tens of milliseconds, draw every plot that needs redrawing before copying any of them.

## Category limits count the whole table

The mark reads each text column's list of values once, from the whole table, and throws past 10,000 values on an axis or 65,535 on `fill`. A filter can leave far fewer values on screen, but the limit still counts all of them. With `vg.dot`, Plot's 10,000 limit on an axis counts only the values in the filtered rows, and `fill` has no limit. So an axis on a 50,000-value column filtered down to 100 values works with `vg.dot` and throws here.

Fix: when the whole-table list is over the limit, read the list again with the mark's filter before each query, for that column only. That costs one extra query each time the filter changes.

## Picking is slow with thousands of huge dots

Picking keeps up to 4096 of the largest dots in a list it checks one by one. With more than 4096 dots whose radius is bigger than the frame diagonal, next to a dense patch of small dots, one pick checks every dot in the patch, which takes about 150 ms. Plot's default radius range stops at 30 px, so this only happens with an explicit `rRange` or data far outside `rDomain`.

Fix: a second grid for the large dots, with cells sized to their radius.

## The tooltip only comes back once the plot holds still

After every redraw the tip waits for the plot to hold still for 150 ms before it picks again. A plot that redraws on every pointer move, such as a crosshair driven by a Param, shows the tip only when the pointer stops.

Fix: reuse the pick index across redraws that don't change the scales, the frame or the data.

## Tooltip dates always read in UTC

A `TIMESTAMPTZ` shows in UTC with a `Z`, not in the viewer's time zone, and a plain `TIMESTAMP` shows no zone at all (`src/tip.js`).

Fix: an option to show timestamps in the viewer's time zone.

## The tooltip ignores d3 format strings

Setting `xTickFormat`, `yTickFormat` or `colorTickFormat` to a function formats both the axis and the tooltip. Setting one to a d3 format string formats only the axis. The tooltip falls back to its own formatting, because turning the string into a function needs `d3-format` and `d3-time-format`, which this package doesn't depend on.

Fix: add those two as dependencies and turn the string into a function the way Plot does: `utcFormat` for a time scale, `format` for everything else.
