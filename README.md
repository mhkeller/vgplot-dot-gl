# vgplot-dot-gl

[![npm](https://img.shields.io/npm/v/@mhkeller/vgplot-dot-gl.svg)](https://www.npmjs.com/package/@mhkeller/vgplot-dot-gl)
[![CI](https://github.com/mhkeller/vgplot-dot-gl/actions/workflows/ci.yml/badge.svg)](https://github.com/mhkeller/vgplot-dot-gl/actions/workflows/ci.yml)

A faster `dot` mark for [vgplot](https://idl.uw.edu/mosaic/) that uses WebGL instead of SVG. Same options as `vg.dot`, same axes, legend, zoom and brush. 

Change `vg.dot(` to `dotGL(` and you're done. If you use a `vg` API object, you can add it there: `createAPIContext({ extensions: { dotGL } })`.

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

## Install

```bash
npm install @mhkeller/vgplot-dot-gl @uwdata/vgplot
```

It works with Mosaic 0.31 (`@uwdata/vgplot` 0.31.x). The mark builds on Mosaic's own `Mark` class, so it lists `@uwdata/mosaic-core`, `@uwdata/mosaic-plot` and `@uwdata/mosaic-sql` as peer dependencies.

## One copy of Mosaic

Listing those three as peer dependencies is this package saying it doesn't bring its own Mosaic, it uses the one your app already has. Installing `@uwdata/vgplot` gives you all three, so most setups are fine and you won't ever have to think about this.

This matters, though, because Mosaic compares some things by identity. Two copies on the page means two different `Mark` classes and, worse, two coordinators. The coordinator is what runs your queries and passes selections between charts, so your charts end up talking to one and the dot mark to the other. It won't throw an error, you'll just get an empty chart – or, it might draw fine but the brush is ignored.

Two situations produce a second copy:

- **A local link**, using `pnpm link`, `npm link` or a `file:` dependency. The linked package looks in its own `node_modules` first, and this repo installs Mosaic to run its tests, so you get two copies by default.
- **A version mismatch**, where your app is on a Mosaic outside the `^0.31.0` range, so the package manager nests a second copy to satisfy the peer range.

The fix that works either way is to tell your bundler to keep one copy. In Vite:

```js
// vite.config.js
export default {
  resolve: {
    dedupe: [
      '@uwdata/vgplot',
      '@uwdata/mosaic-core',
      '@uwdata/mosaic-plot',
      '@uwdata/mosaic-sql'
    ]
  }
};
```

In webpack, point `resolve.alias` at your app's copy of each one.

To check what you have, run `pnpm why @uwdata/mosaic-core` (or `npm ls @uwdata/mosaic-core`) in your app and look for one version at one path. 

## How it works

vgplot builds each chart with Observable Plot, which normally makes one SVG circle for every row. That can get slow. This mark keeps Plot for the axes, scales and legend, and takes over the drawing of the points:

1. **Plot doesn't see the rows.** The mark gives Plot a handful of numbers describing the chart's domains: the lowest and highest x, y and r, and the categories that appear in the rows. Plot works out the same axes, ticks and legend from those as it would from the full columns.
2. **The mark draws the rows.** Plot lets a mark bring its own `render` function. This one draws every point on a single WebGL canvas shared by all the plots on the page. It copies the picture into a small canvas inside the plot's SVG and keeps that canvas from one redraw to the next. 

The canvas sits inside the SVG, so code that reads `svg.scale()` or places things with `getScreenCTM()` keeps working, and the picture shrinks with the SVG when the page is narrow.

## Where the rows come from

A vgplot mark gets its rows in one of two ways, and some of this mark's options only work with the first.

- **Database data**, read with `vg.from('trades')`. Mosaic's coordinator sends the mark's SQL query to the database and returns the result to the mark. Tables, views and SQL subqueries all count. Most vgplot charts are built this way.
- **Array data**, a JavaScript array passed as the mark's data: `dotGL([{ size: 1, price: 2 }, { size: 3, price: 4 }], { x: 'size', y: 'price' })`. Mosaic keeps these rows in the browser and doesn't query the database for them. People use it for a few annotation points or a small dataset written into the code.

Several of this mark's features work by adding to the SQL query, so array data, which has no query, can't use them:

- A text or boolean `x` or `y` throws, because the list of categories comes from the database.
- A text `fill` takes at most 254 values (65,535 with database data).
- `groupby` and `tip.fields` throw when the mark is created.

## Options

Same as `vg.dot`:

| option | what it takes |
|---|---|
| `x`, `y` | column names or SQL expressions (required). Number and date columns give a number or time axis. Text and boolean database columns give a category axis with one slot per value in the rows, sorted, with empty values in the last slot. The column may have up to 10,000 values in the whole table, the same limit Plot has. An explicit domain, `vg.Fixed`, and other marks on the same axis work as they do with `vg.dot`, and dots whose value isn't in the domain aren't drawn. Array data takes number and date columns only, and a text column there throws rather than quietly drawing nothing. |
| `r` | a number, or a column (set `rDomain` / `rRange` on the plot as usual) |
| `fill` | a color (`#hex`, a name, `var(--x)`, `currentColor`), or a column. Text and boolean columns get one color per value in the rows and a swatch legend: up to 65,535 values in the whole table for a database column, 254 for array data. Booleans get Plot's colors for true and false, as with `vg.dot`. Number and date columns get a color ramp with 254 steps and a ramp legend. `colorDomain`, `colorRange`, `colorScheme` and `colorLegend` all apply. A value the color domain leaves out has no color, so those dots are drawn invisible; the mark warns once when that happens. |
| `opacity`, `fillOpacity` | numbers, multiplied together. Overlapping dots add up the way see-through SVG circles do. |
| `clip` | `true` keeps the dots inside the plot frame |

Options only this mark has. The mark reads these itself, so Mosaic and Plot don't treat them as channels. It adds `key`, `groupby` and `orderby` to its SQL query.

| option | default | meaning |
|---|---|---|
| `sort` | `'-r'` | draw big dots first when `r` is a column; `null` keeps the row order. Anything else is an error. |
| `orderby` | `null` | what the query sorts rows by: a column name, `vg.column()`, `desc()` from `@uwdata/mosaic-sql`, or a `vg.sql` fragment such as ``vg.sql`${vg.column('price')} DESC` ``. Dots are drawn in row order, later rows on top, so with `sort: null` this sets which dots end up on top. |
| `blit` | `'drawImage'` | how the picture is copied into the plot. The default is generally the faster option; `'bitmaprenderer'` is there for measuring and is slower on Firefox and Safari |
| `maxCategories` | `65535` | how many different fill values a database column may have (65,535 at most; array data allows 254) |
| `benchmark` | `false` | wait for the graphics card after each draw so `mark.stats` shows real times (slows everything; only for measuring) |
| `fragmentBudget` | `4e7` | roughly how many pixels one frame may paint, counting the whole square each dot sits in. A frame over the budget is drawn at a lower resolution, which is what keeps zooming smooth. Once you stop moving for 150 ms, the mark draws it again at full resolution. Big dots on a high-resolution screen cross the budget first. `Infinity` means always draw at full resolution. `mark.stats.estimate` is the count for the last frame. |
| `key` | `null` | a unique row id: a column name or an expression such as `vg.int32('id')`. It comes back with the data under a private name, and the tooltip looks up extra fields by it. It's only needed when `tip.fields` is set (which are additional fields to show in the tooltip). Without it, the tooltip shows the dot's x, y, fill, r and groupby values. The `key` must be unique per row or the extra fields may come from a different row than the one under the pointer (see [Hover and tooltips](#hover-and-tooltips) for more). |
| `groupby` | `null` | a column name, `vg.column()`, a `vg.sql` expression, or a list of them. Draws one dot per group of rows, for marks with an aggregate channel such as `x: vg.avg('price')`. Needs a database connection, not just plain JSON data. See [Grouping](#grouping). |
| `tip` | `null` | `true`, or `{ fields, maxRadius }`, shows a tooltip for the dot under the pointer (see [Hover and tooltips](#hover-and-tooltips)) |

After each draw `mark.stats` is `{ painter, drawn, uploadMs, drawMs, blitMs, dpr, reduced, estimate }`. On a browser without WebGL2 it has only `painter`, `drawn` and `drawMs`. After the full-resolution redraw it also has `refined: true`, and the plot element fires a `dotgl-refine` event.

## What it doesn't do

No strokes, `symbol`, `rotate`, `dx`/`dy`, per-row opacity, facets (`fx`/`fy`), `title`, `href`, extra `channels`, or the `select` options. The mosaic `highlight`, `toggle` and `region` interactors don't work either, because they need one SVG element per row. Giving one of those options a column is an error when the mark is created; giving it a constant only logs a warning, so an old `vg.dot` call still runs. The dots are not part of the SVG if you save it as an image. The mark always fills its dots; with no `fill` at all you get dots in the text color, not Plot's hollow rings.

It needs WebGL2, which about 96% of browsers have and a slightly larger share of machines can actually start (Linux and virtual machines are where it fails most). On a browser without it the mark quietly draws squares on a plain canvas instead of circles. Everything else stays the same, but it is slower and it skips the lower-resolution-while-zooming trick. That path is also how the tests draw, since there is no graphics card in a test runner.

## Interactors

`nearest`, `intervalX/Y/XY` and `panZoom` work as they do with `vg.dot`. `nearest` works out the screen position of every row on each redraw, which adds time to every zoom step on large tables. Don't put a brush and `panZoom` on the same plot: the brush catches every drag, and when you let go, the zoom doesn't get the mouse-up event, so it keeps panning as you move the mouse. That is how d3's brush and zoom behave together; it has nothing to do with this mark.

## Hover and tooltips

```js
dotGL(vg.from('trades'), { x: 'size', y: 'price', key: vg.int32('id'), tip: { fields: ['id', 'party'] } })
```

With `tip` set, the mark puts a ring around the dot under the pointer and shows a small table next to it: x and y under their axis labels, and `fill` and `r` when they are columns. The `groupby` columns come first, each under its column name, or its SQL for an expression. Text values show as text and dates as ISO dates. The mark finds the dot in the browser from what it painted: the dot drawn on top under the pointer, or else the dot whose edge is nearest, up to `maxRadius` pixels away (default 40). After a redraw, the mark sorts the visible dots into small screen cells once the plot has held still for 150 ms, so zooming stays smooth, and the tip then comes back on the dot under the pointer. When several marks in one plot have `tip`, the plot shows one tip, for the closest dot.

The values in that table come from two places. To draw the plot, the mark asked the database for x, y, `fill`, `r` and the `groupby` columns, so it already has those in the browser and can show them the moment you hover. Any other column, such as an id, a name or a timestamp, isn't in that query. To show one of those the mark has to go back to the database for the single row you are pointing at, and `key` is how it says which row that is.

`fields` adds more columns to the table. Once the pointer rests on a dot for 100 ms, the mark runs `SELECT <fields> FROM <table> WHERE <key> = <the dot's key> LIMIT 1`, one lookup at a time, and keeps the answers until the table changes. `fields` can be a Param holding the list, so the page can change the list without rebuilding the plot. `fields` needs a `key` and database data (see [Where the rows come from](#where-the-rows-come-from)).

Because of that `LIMIT 1`, **the key has to be unique**. If two rows share a key, the lookup takes whichever the database hands back first. A primary key, a row id, or anything you would trust in a `WHERE` clause to name one row is fine. If the table has no such column, add one when you load it, for example `row_number() OVER () AS id`.

### Dates in the tooltip

A date shows according to its SQL type: a `DATE` as `2021-05-06`, a `TIMESTAMP` with its time as `2021-05-06T14:30`, a `TIME` as `14:30:00`. Trailing zero seconds and milliseconds come off, same as Plot. DuckDB's `TIMESTAMP` says nothing about a time zone, so none is shown; a `TIMESTAMPTZ` gets its `Z`. This could probably be improved in future versions.

Set `xTickFormat`, `yTickFormat` or `colorTickFormat` on the plot to a function and the tooltip uses it too, so the tip and the axis always read the same:

```js
vg.plot(
  dotGL(vg.from('trades'), { x: 'day', y: 'price', tip: true }),
  vg.xTickFormat(d => d.getUTCFullYear())
)
```

The axis also accepts a d3 format string there. The tooltip doesn't: turning one into a function needs a date formatting library this package doesn't have, so a string falls through to the formatting above rather than throwing. Possible future improvements.

- For a 64-bit id, use `vg.int32(...)` when the ids fit. 32-bit integers arrive without copying; 64-bit integers are converted one value at a time on every result.
- A `BIGINT` value in `fields` beyond ±2^53 has no exact JavaScript number, so its cell stays empty.
- Dates, timestamps and times all read correctly in `fields` too. A time has no JavaScript
  equivalent, so it arrives as a plain count of microseconds; the mark reads the column's own type off the result and formats it into a time.
- Put `key` only on marks without aggregates. On a mark with aggregates the database rejects the query, because the key is not in its `GROUP BY`.
- Style `.dotgl-tip` (the table, with `th` and `td` inside), `.dotgl-ring` and `.dotgl-swatch` (the fill color next to its value). The defaults are wrapped in `:where()`, so any rule on the page wins.

## Grouping

`groupby` draws one dot per group of rows. This draws one dot per country, placed at that country's average price and average volume:

```js
dotGL(vg.from('trades'), {
  x: vg.avg('price'),
  y: vg.avg('volume'),
  groupby: 'country',
  tip: true
})
```

The database does the grouping. The mark's query is roughly:

```sql
SELECT avg(price) AS x, avg(volume) AS y, country
FROM trades
GROUP BY country
```

Each dot is one group, so every channel needs one value per group. A channel gets that in one of two ways:

- **An aggregate.** An aggregate function turns a group's many values into one: `vg.avg`, `vg.sum`, `vg.min`, `vg.max`, `vg.median` or `vg.count`. `x: vg.avg('price')` gives each country its average price.
- **A plain column, added to the grouping.** The query adds a plain column on a channel to its `GROUP BY`. Add `fill: 'party'` to the example and the chart draws one dot per country and party, colored by party.

The mark needs at least one aggregate channel. If every channel is a plain column, each country has many prices and the database can't choose one for the dot, so it returns this error:

```
Binder Error: column "price" must appear in the GROUP BY clause or must be part of an aggregate function.
```

`groupby` takes a list too: `groupby: ['country', 'year']` draws one dot per country and year. It also takes SQL expressions, like ``vg.sql`date_trunc('month', day)` ``.

Grouping happens in the query, so it needs database data (see [Where the rows come from](#where-the-rows-come-from)). If, instead, you just pass in a normal JavaScript object as your data, the mark throws `dotGL: groupby needs a database table` when it's created.

The tooltip shows the group columns first, each under its column name, or its SQL for an expression. A group column that is also the `fill` column shows once, with its color swatch. `key` doesn't work on a grouped mark: a dot represents many rows, so there is no single row to look up, and the database rejects the query.

To sort the dots by group, pass the group column to `orderby`, as in `orderby: 'country'`. In `mark.data`, a group column keeps its own name, except for an expression or a column whose name a channel already uses; those come back as `__dotgl_group_0`, `__dotgl_group_1`, and so on.

## Things to know

**Category axes and legends follow filters, as with `vg.dot`.** When a brush in another chart filters this mark, a text axis shows only the values that still have rows, and the slots close up. The legend does the same. With no color domain set, Plot gives categories their colors in list order, so when a value drops out, the values after it change color. To keep an axis or the colors the same while you brush, fix the domain from the first draw with `vg.xDomain(vg.Fixed)`, `vg.yDomain(vg.Fixed)` or `vg.colorDomain(vg.Fixed)`; values with no rows then keep an empty slot.

The mark reads the list of values once per table, from the whole table, so the value limits count every value in the table, including ones a filter leaves out.

**A very long list of category values throws.** The list is written into the query text, and the mark throws when that text passes about 3.5 MB, a size many servers reject. The error names the largest column, which is usually, though not always, the one to change.

**Dot sizes match `vg.dot`.** When `r` is a column and you haven't set `rRange`, Plot picks the pixel sizes itself, the same way for any mark: a dot whose value sits at the 25th percentile of the column gets a 3 pixel radius, and every other dot follows on a square-root scale, so a dot's area is proportional to its value. If that would push the largest dot past a 30 pixel radius, all of them shrink by the same factor until it fits. Two examples:

| `r` values | 25th pct | largest | result |
|---|---|---|---|
| spread evenly from 10 to 100 | 33 | 100 | 25th pct dot is 3 px, largest is 5.2 px |
| skewed, a few very large | 25 | 100,000 | untrimmed largest would be 190 px, so all shrink and the largest lands on 30 px |

This mark hands Plot a summary of the column instead of the column, so it works out an estimate of that 25th percentile and passes it along. That is the only reason any of this is worth mentioning: without it your dots would come out a different size than `vg.dot` draws them.

**Free a plot when you throw it away.** Nothing does it for you. It releases the graphics memory and takes the mark out of Mosaic's coordinator. `vg.plot()` returns an element, and its marks are in the element's `value.marks`:

```js
plotEl.value.marks.forEach(m => m.destroy?.());
```

## Demo and tests

```bash
pnpm dev               # Vite demo: DuckDB-WASM, 500k made-up rows, ten plots (one brush filters two), timings, zoom test, side by side with vg.dot
pnpm test              # unit tests (tests/unit): scale math against d3, prepare(), colors, picking, tooltip lookups, and a jsdom check of the scale hints
pnpm test:e2e          # browser tests: Chromium and WebKit, plus Chromium at pixel ratio 1. Firefox joins on CI
pnpm test:e2e:update   # rewrite the screenshot baselines after a visual change you meant to make
```

Firefox only runs when `CI` is set. The Firefox that Playwright ships is its own patched Nightly, and as of Playwright 1.63 that build quits on startup on macOS 27 before it loads a page, so it is left out locally to keep the suite green.

The library is fine in Firefox; only that build can't start. Run `FIREFOX=1 pnpm test:e2e` to put it back once Playwright ships one that works.
