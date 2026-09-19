# Changelog

# 1.0.0

> 2026-09-19

First release. `dotGL` is a `dot` mark for vgplot that draws its dots with WebGL2 instead of one SVG circle per row. It takes `vg.dot`'s options and keeps Plot's axes, scales, legends, zoom and brush, so switching is a matter of changing `vg.dot(` to `dotGL(`. It needs Mosaic 0.31, and one copy of Mosaic on the page. See [One copy of Mosaic](README.md#one-copy-of-mosaic).

**Features**

- `x`, `y`, `r`, `fill`, `opacity`, `fillOpacity` and `clip` work as they do on `vg.dot`. Plot builds the axes, scales and legend from a short summary of the data, so the ticks, domains and dot sizes come out the same as `vg.dot`'s.
- Every plot on the page draws with one shared WebGL2 canvas and copies its picture into a canvas inside its own SVG. Code that reads `svg.scale()` or uses `getScreenCTM()` keeps working, and the picture shrinks with the SVG on a narrow page. Browsers without WebGL2 get plain canvas squares instead of circles.
- Number and date columns arrive from the database as typed arrays with no copying, nulls included. Date columns give a time axis.
- Text and boolean columns from the database are drawn as categories. The database turns each value into a number, and the axis, legend and tooltip show the text. An axis can have up to 10,000 values in the whole table, and `fill` up to 65,535. The axes and legends follow filters the way `vg.dot`'s do, and an explicit domain, `vg.Fixed` or another mark on the same axis all work.
- A number or date `fill` gets a color ramp with 254 steps and a ramp legend.
- `sort: '-r'` draws big dots first, as `vg.dot` does. `orderby` sorts the query, which sets which dots end up on top.
- `groupby` draws one dot per group, for marks with an aggregate channel such as `x: vg.avg('price')`. See [Grouping](README.md#grouping).
- `tip` shows a tooltip for the dot under the pointer. The mark finds the dot in the browser from what it painted, so moving the pointer sends no queries. With a `key`, `tip.fields` looks up more columns for one row once the pointer rests. Dates show by their SQL type, and a tick format function on the plot formats the tooltip too. See [Hover and tooltips](README.md#hover-and-tooltips).
- `mark.stats` has the timings of each draw. `benchmark: true` makes them wait for the graphics card so they are real.
- TypeScript types for the mark and its options.

**Performance**

- A frame that would paint more than `fragmentBudget` pixels draws at a lower resolution while you zoom, and again at full resolution once the plot has been still for 150 ms.
- When a resize gets the same result back from Mosaic's cache, the mark reuses the prepared rows and the data already on the graphics card.

**Limits**

- No strokes, `symbol`, `rotate`, `dx`/`dy`, per-row opacity or facets, and the `highlight`, `toggle` and `region` interactors don't work. Giving one of those options a column throws when the mark is created; a constant logs a warning, so an old `vg.dot` call still runs. See [What it doesn't do](README.md#what-it-doesnt-do).
- Array data takes number and date `x` and `y` only, and up to 254 `fill` values. `groupby` and `tip.fields` need database data. See [Where the rows come from](README.md#where-the-rows-come-from).
- Known gaps and their planned fixes are in [ROADMAP.md](ROADMAP.md).
