import type { Mark } from '@uwdata/mosaic-plot';
import type { GroupByExpr, OrderByExpr } from '@uwdata/mosaic-sql';

/** The vg.dot options (x, y, r, fill, opacity, fillOpacity, clip, ...) plus the options only this mark has. */
export interface DotGLOptions {
  /** How the picture is copied into the plot. Default 'drawImage', which is the fast path everywhere; 'bitmaprenderer' is for measuring. */
  blit?: 'drawImage' | 'bitmaprenderer';
  /** '-r' draws big dots first when r is a column; null keeps the row order. Default '-r'. */
  sort?: '-r' | null;
  /** What the query sorts rows by: a column name, `column()`, `desc()` or a `sql` fragment. Rows are drawn in that order. */
  orderby?: OrderByExpr | null;
  /** How many different fill values a database column may have. Default and maximum 65,535; array data allows 254. */
  maxCategories?: number;
  /** Wait for the graphics card after each draw so `stats` shows real times. */
  benchmark?: boolean;
  /** How much painting one frame may do before the mark draws at a lower resolution while you zoom. Default 4e7. */
  fragmentBudget?: number;
  /** A unique row id: a column name or an expression such as `vg.int32('id')`. The tooltip looks up `tip.fields` by it. */
  key?: unknown;
  /** Columns the query groups by, for x and y aggregates: a column name, `column()` or expression, or an array of them. The tooltip shows each one. */
  groupby?: GroupByExpr | null;
  /** Show a tooltip for the dot under the pointer. `fields` (column names, or a Param holding them) need `key` and a database table; `maxRadius` defaults to 40 px. */
  tip?: boolean | { fields?: string[] | { value: string[] }; maxRadius?: number };
  [option: string]: unknown;
}

/** Timings and counts from the last draw. Without WebGL2 the mark draws squares on a plain canvas and fills in only painter, drawn and drawMs. */
export interface DotGLStats {
  painter: 'gl' | 'rect2d';
  drawn?: number;
  uploadMs?: number;
  drawMs?: number;
  blitMs?: number;
  dpr?: number;
  /** The frame was drawn at a lower resolution while zooming. */
  reduced?: boolean;
  /** The full-resolution redraw after zooming stopped. */
  refined?: boolean;
  /** Estimated pixels painted for the frame. */
  estimate?: number;
  /** Set when nothing was drawn, for example 'context lost'. */
  skipped?: string;
}

export declare class DotGLMark extends Mark {
  constructor(source: unknown, options?: DotGLOptions);
  stats: DotGLStats | null;
}

/** Use inside vg.plot() in place of vg.dot. */
export declare function dotGL(source: unknown, options?: DotGLOptions): (plot: any) => void;
