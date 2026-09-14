# Roadmap

Work that is known and not yet done. Each item says what goes wrong, when it is worth doing, and a sketch of the fix.

## The paint budget counts dots that are off screen

**Problem.** `estimateFragments` (`src/painters/gl.js`) multiplies the dot area by every uploaded dot. When you zoom far into a dense plot, most dots are outside the frame, but the estimate still goes over `fragmentBudget`, so zoom frames draw at a lower resolution than they need.

**Act when** someone sees blurry zoom frames on a zoomed-in plot that has few dots on screen.

**Sketch.** Estimate from the share of the data range that is on screen (the scale domain against `prep.extent`), or from how many dots the last frame put inside the frame.

## Lower resolution while zooming stops at pixel ratio 1

**Problem.** The reduced zoom frame never goes below pixel ratio 1 (`MIN_REDUCED_DPR`). On a 1x screen, or at 2M+ rows with large dots, a zoom frame still paints hundreds of millions of pixels.

**Act when** zoom speed at 2M+ rows is a complaint. Measure frames per second at `MIN_REDUCED_DPR` 1 and 0.5 first.

**Sketch.** Lower `MIN_REDUCED_DPR` to 0.5 if the measurement shows a clear gain.

## Copying the picture waits for the graphics card

**Problem.** `blitTo` (`src/shared-gl.js`) copies the shared WebGL canvas into each plot with `drawImage`, which makes the page wait until the graphics card has finished the frame. When several plots redraw in the same frame (a brush that filters them all), each copy waits in turn.

**Act when** `mark.stats.blitMs` reads tens of milliseconds on pages with several plots.

**Sketch.** Read `blitMs` with `benchmark` off on a many-plot page. If the wait dominates, try `bitmaprenderer` per plot, or draw every plot that redraws in one frame before copying any of them.

## Category axes need Plot's own even spacing

**Problem.** A text axis places category code i on the straight line through Plot's pixels for the category rows (`categoryLine` in `src/scale-map.js`). An explicit domain that leaves out categories or reorders them, or another mark that adds values to the same scale, breaks that line, and the mark throws.

**Act when** someone needs an explicit domain on a text axis, or a second mark sharing it.

**Sketch.** Upload a per-code position table as a small texture, the same way the palette works, and look positions up in the shader. Codes missing from the domain get a hidden position.

## Text axes keep every category under a cross-filter

**Problem.** The category list comes from the whole table, once per table. When a cross-filter narrows the rows, a text axis still shows a slot for every value; `vg.dot`'s axis shrinks to the values left.

**Act when** someone asks for a text axis that follows a filter.

**Sketch.** Keep the codes from the whole table, and pass Plot only the categories present in the current result (the codes that occur), so the axis shrinks while colors stay stable.

## Picking slows down with thousands of dots larger than the frame

**Problem.** Picking keeps up to 4096 of the largest dots in a list it checks one by one, and bounds its search by the largest remaining radius. With more than 4096 dots whose radius is larger than the frame diagonal, next to a dense patch of small dots, a pick checks every dot in that patch, about 150 ms.

**Act when** a real dataset shows slow hovers with huge dots. Plot's default radius range stops at 30 px, so this needs an explicit `rRange` or data far outside `rDomain`.

**Sketch.** Keep a second grid for the large dots with cells sized to their radius.

## The tooltip waits for a still plot

**Problem.** After every redraw the tip waits until the plot has held still for 150 ms before it picks again. A plot that redraws on every pointer move (a crosshair driven by a Param) shows the tip only when the pointer rests.

**Act when** someone combines `tip` with an interactor that redraws on pointer moves.

**Sketch.** Reuse the pick index across redraws whose scales, frame and data are unchanged.
