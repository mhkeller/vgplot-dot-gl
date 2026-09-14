# vgplot-dot-gl

A faster `dot` mark for [vgplot](https://idl.uw.edu/mosaic/). Same options as `vg.dot`, same axes, legend, zoom and brush. The difference is that the graphics card draws the points, so a few hundred thousand of them show up in milliseconds instead of freezing the tab.

```js
import * as vg from '@uwdata/vgplot';
import { dotGL } from '@mhkeller/vgplot-dot-gl';

vg.plot(
  dotGL(vg.from('trades'), { x: 'size', y: 'price', r: 'volume', fill: 'party', opacity: 0.6, clip: true }),
  vg.rRange([2, 11]), vg.rDomain([lo, hi]),
  vg.colorDomain(['D', 'R']), vg.colorRange(['#2166ac', '#b2182b']), vg.colorLegend({ columns: 1 }),
  vg.xScale('log'), vg.panZoom({ x: xsel, y: ysel, xfield: 'size', yfield: 'price' }),
  vg.width(430), vg.height(330)
)
```

Change `vg.dot(` to `dotGL(` and you're done. If you use a `vg` API object, you can add it there: `createAPIContext({ extensions: { dotGL } })`.

## How it works

vgplot builds each chart with Observable Plot, which normally makes one SVG circle for every row. That is what gets slow. This mark keeps Plot for the axes, scales and legend, and takes over only the drawing of the points:

1. **Plot never sees the rows.** The mark hands Plot a handful of numbers instead: the lowest and highest x, y and r, and the list of categories. Plot works out the same axes, ticks and legend from those as it would from the full columns.
2. **The mark draws the rows itself.** Plot lets a mark bring its own `render` function. This one draws every point on a single WebGL canvas that all the plots on the page share, copies the picture into a small canvas inside the plot's SVG, and keeps that canvas from one redraw to the next. vgplot rebuilds the whole SVG on every filter change and every zoom step; for this mark a zoom step is one draw and one copy.

The canvas sits inside the SVG, so code that reads `svg.scale()` or places things with `getScreenCTM()` keeps working, and the picture shrinks with the SVG when the page is narrow.

## Options

Same as `vg.dot`:

| option | what it takes |
|---|---|
| `x`, `y` | column names or SQL expressions (required). Number and date columns give a number or time axis. Text and boolean database columns give a category axis with one slot per value, sorted, with empty values in the last slot; up to 10,000 values, the same limit Plot has. An explicit domain or another mark that leaves out categories or spaces them unevenly is an error. Array data takes number and date columns only. |
| `r` | a number, or a column (set `rDomain` / `rRange` on the plot as usual) |
| `fill` | a color (`#hex`, a name, `var(--x)`, `currentColor`), or a column. Text and boolean columns get one color per value and a swatch legend: up to 65,535 values from a database column, 254 from array data. Number and date columns get a color ramp with 254 steps and a ramp legend. `colorDomain`, `colorRange`, `colorScheme` and `colorLegend` all apply. |
| `opacity`, `fillOpacity` | numbers, multiplied together. Overlapping dots add up the way see-through SVG circles do. |
| `clip` | `true` keeps the dots inside the plot frame |

Options only this mark has. Mosaic and Plot never see them as channels; the mark adds `orderby` to its query itself.

| option | default | meaning |
|---|---|---|
| `painter` | `'gl'` | `'gl'` draws with the graphics card, `'rect2d'` draws squares on a plain canvas, `'dot'` is the original SVG dots |
| `fallback` | `'rect2d'` | what to use when the browser has no WebGL2 |
| `sort` | `'-r'` | draw big dots first when `r` is a column; `null` keeps the row order. Anything else is an error. |
| `orderby` | `null` | what the query sorts rows by: a column name, `vg.column()`, `desc()` from `@uwdata/mosaic-sql`, or a `vg.sql` fragment such as ``vg.sql`${vg.column('price')} DESC` ``. Dots are drawn in row order, later rows on top, so with `sort: null` this sets which dots end up on top. |
| `blit` | `'drawImage'` | how the picture is copied into the plot; `'bitmaprenderer'` is there for timing comparisons |
| `maxCategories` | `65535` | how many different fill values a database column may have (65,535 at most; array data allows 254) |
| `benchmark` | `false` | wait for the graphics card after each draw so `mark.stats` shows real times (slows everything; only for measuring) |
| `fragmentBudget` | `4e7` | how much painting one frame may do before the mark draws at a lower resolution while you zoom, then repaints sharp 150 ms after you stop; `Infinity` turns this off |

After each WebGL draw `mark.stats` holds `{ painter, drawn, uploadMs, drawMs, blitMs, dpr, reduced, estimate }` (the `rect2d` painter gives only `painter`, `drawn` and `drawMs`). After the sharp repaint it also has `refined: true`, and the plot element fires a `dotgl-refine` event.

## What it doesn't do

No strokes, `symbol`, `rotate`, `dx`/`dy`, per-row opacity, facets (`fx`/`fy`), Plot tooltips (`tip`, `title`, `href`), extra `channels`, or the `select` options. The mosaic `highlight`, `toggle` and `region` interactors don't work either, because they need one SVG element per row. Giving one of those options a column is an error when the mark is created; giving it a constant only logs a warning once, so an old `vg.dot` call still runs. The dots are not part of the SVG if you save it as an image. The mark always fills its dots; with no `fill` at all you get dots in the text color, not Plot's hollow rings.

## Interactors

`nearest`, `intervalX/Y/XY` and `panZoom` work as they do with `vg.dot`. Don't put a brush and `panZoom` on the same plot: the brush catches every drag, and when you let go the zoom never hears about it and keeps panning as you move the mouse. That is how d3's brush and zoom behave together; it has nothing to do with this mark.

## Hover and tooltips

There is no SVG element per row to hover, so ask the database which row is under the mouse instead. `demo/hover-probe.js` shows how: turn the mouse position into data values with `svg.scale('x'|'y')`, query for the
nearest row, and put a ring on it using the SVG's `getScreenCTM()`. Three things to get right:

- When dots have different sizes, pick the dot whose circle covers the mouse, not the dot with the nearest center.
  `radiusSQL` in the demo puts the plot's radius scale into the query.
- Give the ring `box-sizing: border-box`, or its border pushes it off center.
- Hide the ring whenever the plot redraws, and on wheel events using a capture listener. d3-zoom stops the wheel event
  before normal listeners see it, and after a zoom the dots have moved out from under the tooltip.

## Large data

- Number and date columns come back from the database as doubles (dates as milliseconds, nulls as NaN). They arrive as typed arrays with no copying, including columns with nulls and `BIGINT` or `DECIMAL` columns.
- Text and boolean columns on `x`, `y` and `fill` arrive as one- or two-byte integers. The mark asks for the distinct values once per table, and the data query returns each row's position in that list through a single `ENUM` lookup. The list comes from the whole table, so axes and legends stay the same across filters. The lists travel inside the query text, so very long text values can make the query too large to send; the mark then throws an error naming the column. Mosaic can combine the unfiltered queries of several plots on one table into one request, and their lists then add up. Array data and `painter: 'dot'` keep the plain columns.
- Plot picks a default dot size range from the 25th percentile of the `r` values. The mark passes an estimate of that along so the default matches. If you set `rRange`, this doesn't matter.
- All plots share one WebGL context, so a page with many plots stays far from the browser's limit. Call `mark.destroy()` when you throw a plot away; it frees the graphics memory too.

## Demo and tests

```bash
pnpm dev               # Vite demo: DuckDB-WASM, 500k made-up rows, seven plots, timings, zoom test, side by side with vg.dot
pnpm test              # unit tests (tests/unit): scale math against d3, prepare(), colors, and a jsdom check of the scale hints
pnpm test:e2e          # browser tests: Chromium, Firefox and WebKit, plus Chromium at pixel ratio 1
pnpm test:e2e:update   # rewrite the screenshot baselines after a visual change you meant to make
```

The browser suite (`tests/e2e/`) opens the demo with seeded data (`?rows=50000&seed=0.42`) and, in each browser, checks that all seven plots draw without errors, that dots land exactly where `vg.dot` puts its circles and stay lined up with the axes after zooming, that a text axis and a text fill with 601 values put each dot at its category in its color, that a brush filters the linked panel, that the hover ring lands on the dot under the mouse, that the mark recovers when the browser drops the WebGL context, and that a narrow page still lines up. Screenshot baselines sit next to the specs, one per browser, with the timing text masked out. `tests/e2e/perf.spec.js` loads 500k rows per plot and prints the timings and the name of the graphics driver. Headless browsers sometimes draw in software; treat those numbers as a worst case.

Results: the suite passes in Chromium, Firefox and WebKit (Safari's engine) on macOS at pixel ratio 2 and 1. Firefox and WebKit use the real graphics card even headless and zoom 500k rows at 44–48 fps, with the copy step under 2 ms. Headless Chromium draws in software, so only its pass/fail counts.

Measured in Chromium on an Apple M3 with a high-resolution screen, 500k rows in each of seven 430×330 plots: all seven ready about 1.2 s after the data arrives; zooming one plot at about 33 fps; the same 50k-row plot takes 125 ms as SVG circles and 7 ms here; 2M rows per plot load in about 2 s and zoom at about 30 fps at lower resolution. What limits speed is how many pixels get painted, not how many rows: big see-through dots on a high-resolution screen are the slow case, and that is what the lower-resolution-while-zooming behavior is for.
