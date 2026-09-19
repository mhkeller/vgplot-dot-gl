import { transformFor, affine, axisAffine, axisTransform } from './scale-map.js';

/**
 * Finds the dot under a point from what the mark painted, without the database.
 *
 * `buildPickIndex` sorts every visible dot of one paint into small screen cells,
 * using the same scales, hide rules, clip frame and half-pixel offset as the
 * painters. `pickDot` then looks only at the cells around the pointer, ring by
 * ring, and stops as soon as no farther cell can hold a better dot.
 */

/** Side of one grid cell, in CSS pixels. */
const CELL = 2;

/** Most dots kept out of the grid for their size. `pickDot` checks each of them on every pick, about 0.1 ms for all of them. */
const LARGE_DOTS = 4096;

/**
 * The pick index for one paint (the mark's `lastPaint`). Cells cover the frame. A dot
 * centered outside the frame that pokes into it goes in the nearest edge cell, which
 * is closer to any pointer in the frame than the dot's center is. The few largest dots
 * go in a list after the last cell, so the walk around the pointer only has to reach
 * as far as the largest dot left in the grid. Within a cell and the list, draw indices rise.
 */
export function buildPickIndex(mark, paint) {
  const { sx, sy, sr, lines, frame, style, prep } = paint;
  const empty = { paint, idx: new Uint32Array(0) };
  if (style.opacity <= 0 || (!style.palette && style.fillRGBA[3] <= 0)) return empty;

  const { fw, fh, offset } = frame;
  const column = name => mark.data.columns[mark.channelField(name, { exact: true }).as];
  const X = column('x');
  const Y = column('y');
  const R = sr ? column('r') : null;
  const tx = axisTransform(sx, lines.x, 'x');
  const ty = axisTransform(sy, lines.y, 'y');
  const tr = sr ? transformFor(sr, 'r') : null;
  const ax = axisAffine(sx, lines.x, 0, -frame.fx, 'x');
  const ay = axisAffine(sy, lines.y, 0, -frame.fy, 'y');
  const ar = sr ? affine(sr, 0, 0, 'r') : null;

  const W = Math.max(1, Math.ceil(fw / CELL));
  const H = Math.max(1, Math.ceil(fh / CELL));
  const { perm, codes, hidden, n, total } = prep;
  const palette = style.palette;
  const cellOf = new Int32Array(total).fill(-1);
  // Radii are counted in whole pixels up to the frame's diagonal. A walk that far already reaches every cell, so larger radii share the last count.
  const bins = Math.ceil(Math.hypot(fw, fh));
  const radii = R ? new Uint32Array(bins + 1) : null;
  let rmax = 0;
  // Rows go in row order, which reads the columns straight through memory. Rows left out of the draw order have the hidden code.
  for (let j = 0; j < total; ++j) {
    const code = codes[j];
    if (code === hidden || (palette && palette[code * 4 + 3] === 0)) continue;
    const px = ax.a * tx(+X[j]) + ax.b + offset;
    const py = ay.a * ty(+Y[j]) + ay.b + offset;
    const r = R ? ar.a * tr(+R[j]) + ar.b : style.r;
    // Written as "not inside" so NaN positions and radii are skipped too. Neither painter draws an infinite radius.
    if (!(r > 0 && r < Infinity && px + r >= 0 && px - r <= fw && py + r >= 0 && py - r <= fh)) continue;
    cellOf[j] = Math.min(H - 1, Math.max(0, Math.floor(py / CELL))) * W + Math.min(W - 1, Math.max(0, Math.floor(px / CELL)));
    if (r > rmax) rmax = r;
    if (radii) ++radii[Math.min(bins, Math.ceil(r))];
  }

  // `cap` is the smallest whole-pixel radius that at most LARGE_DOTS dots exceed. When more than that
  // many are bigger than the diagonal, every dot stays in the grid and `cap` is the largest radius.
  let cap = rmax;
  if (radii && radii[bins] <= LARGE_DOTS) {
    let above = radii[bins];
    cap = bins - 1;
    while (cap > 0 && above + radii[cap] <= LARGE_DOTS) above += radii[cap--];
  }
  const large = W * H;
  const start = new Uint32Array(large + 2);
  for (let j = 0; j < total; ++j) {
    if (cellOf[j] < 0) continue;
    if (cap < rmax && ar.a * tr(+R[j]) + ar.b > cap) cellOf[j] = large;
    ++start[cellOf[j]];
  }
  // Counting sort: after the running sum, start[c] is where cell c ends. Placing dots from the
  // last draw index down moves it back to where cell c begins and leaves the indices rising.
  for (let c = 1; c <= large + 1; ++c) start[c] += start[c - 1];
  const idx = new Uint32Array(start[large + 1]);
  for (let i = n - 1; i >= 0; --i) {
    const c = cellOf[perm[i]];
    if (c >= 0) idx[--start[c]] = i;
  }
  return { paint, cap, W, H, start, idx, X, Y, R, tx, ty, tr, ax, ay, ar };
}

/**
 * The dot at (x, y), in CSS pixels from the top left of the paint's frame: the dot
 * drawn last among those covering the point, or else the dot whose edge is
 * closest, up to `maxRadius` away. Distances are to a circle for the 'gl' painter
 * and to a square for 'rect2d'. Returns `{ i, j, px, py, r, key }` (draw index, row,
 * center in frame pixels, radius, distance to the edge with 0 inside) or null.
 */
export function pickDot(index, x, y, maxRadius) {
  const { paint, idx } = index;
  const { fw, fh, offset } = paint.frame;
  if (!idx.length || !(x >= 0 && x <= fw && y >= 0 && y <= fh)) return null;

  const { cap, W, H, start, X, Y, R, tx, ty, tr, ax, ay, ar } = index;
  const { perm } = paint.prep;
  const square = paint.painter === 'rect2d';
  let best = -1;
  let bestKey = Infinity;
  let hit = null;
  const scan = c => {
    for (let s = start[c + 1] - 1; s >= start[c]; --s) {
      const i = idx[s];
      // Indices fall from here on, so none of them can beat a covering dot drawn later.
      if (bestKey === 0 && i <= best) break;
      const j = perm[i];
      const px = ax.a * tx(+X[j]) + ax.b + offset;
      const py = ay.a * ty(+Y[j]) + ay.b + offset;
      const r = R ? ar.a * tr(+R[j]) + ar.b : paint.style.r;
      const dx = Math.abs(px - x);
      const dy = Math.abs(py - y);
      const key = Math.max(0, (square ? Math.max(dx, dy) : Math.sqrt(dx * dx + dy * dy)) - r);
      if (key > maxRadius || key > bestKey || (key === bestKey && i < best)) continue;
      best = i;
      bestKey = key;
      hit = { i, j, px, py, r, key };
    }
  };

  // The dots too large for the grid, one by one.
  scan(W * H);
  // Rings of cells around the pointer's cell. A center in ring k is at least (k - 1) * CELL pixels from the
  // pointer, so its edge is at least that minus cap away; past the best edge distance so far, or past the grid, the walk stops.
  const gx = Math.min(W - 1, Math.floor(x / CELL));
  const gy = Math.min(H - 1, Math.floor(y / CELL));
  const kmax = Math.min((cap + maxRadius) / CELL + 1, Math.max(gx, W - 1 - gx, gy, H - 1 - gy));
  for (let k = 0; k <= kmax && (k - 1) * CELL - cap <= bestKey; ++k) {
    const x0 = Math.max(0, gx - k);
    const x1 = Math.min(W - 1, gx + k);
    for (let cx = x0; cx <= x1; ++cx) {
      if (gy - k >= 0) scan((gy - k) * W + cx);
      if (k > 0 && gy + k < H) scan((gy + k) * W + cx);
    }
    const y1 = Math.min(H - 1, gy + k - 1);
    for (let cy = Math.max(0, gy - k + 1); cy <= y1; ++cy) {
      if (gx - k >= 0) scan(cy * W + gx - k);
      if (k > 0 && gx + k < W) scan(cy * W + gx + k);
    }
  }
  return hit;
}
