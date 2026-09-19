// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as Plot from '@observablehq/plot';
import { DotGLMark } from '../../src/DotGLMark.js';
import { buildPickIndex, pickDot } from '../../src/pick.js';

const MAX_RADIUS = 40;

function random(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

/** Rows spread over a small plot, so dots overlap and many pointers land near several of them. */
function scatter(n, seed = 3) {
  const rand = random(seed);
  const parties = ['D', 'I', 'R'];
  return Array.from({ length: n }, () => ({ a: rand() * 100, b: rand() * 50, size: rand() * 20, party: parties[Math.floor(rand() * 3)] }));
}

/**
 * Plots the mark the way vgplot would, with the rect2d painter drawing into a stub 2D canvas (jsdom has none).
 * The mark's `lastPaint` then holds the real scales, and the figure's own scales feed the reference.
 */
function painted(rows, options, plot = {}, setup = () => {}) {
  const mark = new DotGLMark(rows, { ...options });
  setup(mark);
  const ctx = { setTransform() {}, clearRect() {}, fillRect() {} };
  const canvas2d = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type => (type === '2d' ? ctx : null));
  try {
    const [{ data, options: o }] = mark.plotSpecs();
    const fig = Plot.plot({ document, width: 320, height: 240, ...plot, marks: [Plot.dot(data, o)] });
    return { mark, fig };
  } finally {
    canvas2d.mockRestore();
  }
}

/** Row j's center and radius in frame pixels, from Plot's scales. */
function dotAt(mark, fig, paint, j) {
  const { frame, prep, style } = paint;
  const value = name => {
    const f = mark.channelField(name, { exact: true });
    return f ? mark.data.columns[f.as][j] : null;
  };
  const px = fig.scale('x').apply(prep.xCats ? prep.xCats[value('x')] : value('x')) - frame.fx + frame.offset;
  const py = fig.scale('y').apply(prep.yCats ? prep.yCats[value('y')] : value('y')) - frame.fy + frame.offset;
  const r = mark.channelField('r', { exact: true }) ? fig.scale('r').apply(value('r')) : style.r;
  return { px, py, r };
}

/**
 * The picking rule checked one dot at a time: among visible dots the one drawn last that covers the point,
 * else the one whose edge is closest (the later one on a tie), within MAX_RADIUS.
 */
function reference(mark, fig, paint, x, y) {
  const { frame, style, prep, painter } = paint;
  if (!(x >= 0 && x <= frame.fw && y >= 0 && y <= frame.fh) || style.opacity <= 0) return null;
  let best = null;
  for (let i = 0; i < prep.n; ++i) {
    const j = prep.perm[i];
    const code = prep.codes[j];
    if (code === prep.hidden || (style.palette && style.palette[code * 4 + 3] === 0)) continue;
    const { px, py, r } = dotAt(mark, fig, paint, j);
    if (!(r > 0 && r < Infinity) || !Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (px + r < 0 || px - r > frame.fw || py + r < 0 || py - r > frame.fh) continue;
    const dx = Math.abs(px - x);
    const dy = Math.abs(py - y);
    const key = Math.max(0, (painter === 'rect2d' ? Math.max(dx, dy) : Math.hypot(dx, dy)) - r);
    if (key <= MAX_RADIUS && (!best || key <= best.key)) best = { i, j, key };
  }
  return best;
}

/** Pointers all over the plot, some outside the frame, plus pointers on and around dots. */
function pointers(mark, fig, paint, seed = 11) {
  const rand = random(seed);
  const { frame, prep } = paint;
  const list = Array.from({ length: 600 }, () => [rand() * (frame.fw + 40) - 20, rand() * (frame.fh + 40) - 20]);
  for (let k = 0; k < 300; ++k) {
    const { px, py } = dotAt(mark, fig, paint, prep.perm[Math.floor(rand() * prep.n)]);
    list.push([px + (rand() - 0.5) * 12, py + (rand() - 0.5) * 12]);
  }
  return list;
}

/** Checks pickDot against the reference at every pointer. Returns the picks, so a case can check what was picked. */
function compare(mark, fig, paint) {
  const index = buildPickIndex(mark, paint);
  const picks = [];
  for (const [x, y] of pointers(mark, fig, paint)) {
    const want = reference(mark, fig, paint, x, y);
    const got = pickDot(index, x, y, MAX_RADIUS);
    expect(got && { i: got.i, j: got.j }, `pointer ${x}, ${y}`).toEqual(want && { i: want.i, j: want.j });
    if (got) picks.push(got);
  }
  return picks;
}

describe('pickDot matches the one-dot-at-a-time rule', () => {
  const rows = scatter(400);

  it('on linear scales with a fixed radius, as circles and as rect2d squares', () => {
    const { mark, fig } = painted(rows, { x: 'a', y: 'b', r: 4 });
    expect(compare(mark, fig, { ...mark.lastPaint, painter: 'gl' }).length).toBeGreaterThan(500);
    expect(compare(mark, fig, mark.lastPaint).length).toBeGreaterThan(500);
  });

  it('on log x and y scales, skipping values a log scale cannot place', () => {
    const logRows = rows.map((d, i) => ({ ...d, a: i % 13 === 0 ? 0 : Math.exp(d.a / 15), b: i % 17 === 0 ? -1 : d.b + 1 }));
    const { mark, fig } = painted(logRows, { x: 'a', y: 'b', r: 3 }, { x: { type: 'log' }, y: { type: 'log' } });
    const picks = compare(mark, fig, { ...mark.lastPaint, painter: 'gl' });
    expect(picks.length).toBeGreaterThan(400);
    expect(picks.every(p => p.j % 13 !== 0 && p.j % 17 !== 0)).toBe(true);
  });

  it("with a sqrt radius column, in '-r' order and in row order", () => {
    for (const sort of ['-r', null]) {
      const { mark, fig } = painted(rows, { x: 'a', y: 'b', r: 'size', fill: 'party', sort });
      expect(mark.lastPaint.sr).toMatchObject({ type: 'pow', exponent: 0.5 });
      expect(compare(mark, fig, { ...mark.lastPaint, painter: 'gl' }).length).toBeGreaterThan(500);
      expect(compare(mark, fig, mark.lastPaint).length).toBeGreaterThan(500);
    }
  });

  it('on a time x axis of epoch milliseconds', () => {
    const timeRows = rows.map(d => ({ ...d, a: Date.UTC(2020, 0, 1) + d.a * 3 * 864e5 }));
    const { mark, fig } = painted(timeRows, { x: 'a', y: 'b', r: 'size' }, {}, m => { m.channelField('x').type = 'date'; });
    expect(mark.lastPaint.sx.type).toBe('utc');
    expect(compare(mark, fig, { ...mark.lastPaint, painter: 'gl' }).length).toBeGreaterThan(500);
  });

  it('on a text x axis of category codes', () => {
    const codeRows = rows.map((d, i) => ({ ...d, letter: i % 11 === 0 ? 255 : i % 4 }));
    const { mark, fig } = painted(codeRows, { x: 'letter', y: 'b', r: 'size' }, {}, m => {
      m.categories.set('letter', { cats: ['a', 'b', 'c', null] });
    });
    expect(mark.lastPaint.sx.type).toBe('point');
    const picks = compare(mark, fig, { ...mark.lastPaint, painter: 'gl' });
    expect(picks.length).toBeGreaterThan(500);
    expect(picks.every(p => p.j % 11 !== 0)).toBe(true);
  });

  it('never picks hidden rows or rows in a transparent color', () => {
    const codeRows = rows.map((d, i) => ({ ...d, party: i % 9 === 0 ? 255 : i % 3 }));
    const color = { domain: ['D', 'I', 'R'], range: ['red', 'transparent', 'blue'] };
    const { mark, fig } = painted(codeRows, { x: 'a', y: 'b', r: 'size', fill: 'party' }, { color }, m => {
      m.categories.set('party', { cats: ['D', 'I', 'R'] });
    });
    const paint = { ...mark.lastPaint, painter: 'gl' };
    const { perm, codes, hidden } = paint.prep;
    const hiddenRows = new Set();
    for (let i = 0; i < perm.length; i += 10) {
      codes[perm[i]] = hidden;
      hiddenRows.add(perm[i]);
    }
    const picks = compare(mark, fig, paint);
    expect(picks.length).toBeGreaterThan(300);
    expect(picks.every(p => p.j % 9 !== 0 && !hiddenRows.has(p.j) && codes[p.j] !== 1)).toBe(true);
  });

  it('skips dots whose radius comes out zero or negative', () => {
    const { mark, fig } = painted(rows, { x: 'a', y: 'b', r: 'size' }, { r: { type: 'linear', domain: [0, 20], range: [-6, 10] } });
    const picks = compare(mark, fig, { ...mark.lastPaint, painter: 'gl' });
    expect(picks.length).toBeGreaterThan(300);
    expect(picks.every(p => p.r > 0 && mark.data.columns.size[p.j] > 7.5)).toBe(true);
  });

  it('skips dots whose radius comes out infinite', () => {
    const zeroRows = rows.map((d, i) => ({ ...d, size: i % 7 === 0 ? 0 : d.size + 0.01 }));
    const { mark, fig } = painted(zeroRows, { x: 'a', y: 'b', r: 'size' }, { r: { type: 'log', domain: [0.01, 20], range: [12, 2] } });
    const picks = compare(mark, fig, { ...mark.lastPaint, painter: 'gl' });
    expect(picks.length).toBeGreaterThan(300);
    expect(picks.every(p => p.j % 7 !== 0)).toBe(true);
  });

  it('keeps a few huge dots out of the grid', () => {
    const outliers = rows.map((d, i) => ({ ...d, size: i === 150 ? 5e6 : i === 250 ? 2e5 : d.size }));
    const { mark, fig } = painted(outliers, { x: 'a', y: 'b', r: 'size' }, { r: { type: 'sqrt', domain: [0, 20], range: [0, 8] } });
    const paint = { ...mark.lastPaint, painter: 'gl' };
    expect(buildPickIndex(mark, paint).cap).toBeLessThan(8);
    const picks = compare(mark, fig, paint);
    // Both cover the whole plot; the second is drawn over the first.
    expect(picks.some(p => p.j === 250)).toBe(true);
  });

  it('keeps every dot in the grid when too many are huge, and walks no farther than the grid', () => {
    const huge = Array.from({ length: 4100 }, (_, i) => ({ a: (i * 37) % 100, b: (i * 11) % 50, size: i ? 5e6 : 5e12 }));
    const { mark, fig } = painted([...rows, ...huge], { x: 'a', y: 'b', r: 'size' }, { r: { type: 'sqrt', domain: [0, 20], range: [0, 8] } });
    const paint = { ...mark.lastPaint, painter: 'gl' };
    const index = buildPickIndex(mark, paint);
    expect(index.cap).toBeGreaterThan(1e6);
    // A walk out to the largest radius would take seconds per pick.
    for (const [x, y] of pointers(mark, fig, paint).slice(0, 40)) {
      const want = reference(mark, fig, paint, x, y);
      expect(pickDot(index, x, y, MAX_RADIUS)?.i ?? null, `pointer ${x}, ${y}`).toBe(want?.i ?? null);
    }
  });

  it('picks only inside a clipped frame, including dots that poke in from outside', () => {
    const { mark, fig } = painted(rows, { x: 'a', y: 'b', r: 'size', clip: true }, { x: { domain: [20, 80] }, y: { domain: [10, 40] } });
    const paint = { ...mark.lastPaint, painter: 'gl' };
    const { fw, fh } = paint.frame;
    expect(paint.frame.fx).toBeGreaterThan(0);
    expect(compare(mark, fig, paint).length).toBeGreaterThan(400);
    expect(compare(mark, fig, mark.lastPaint).length).toBeGreaterThan(400);
    const index = buildPickIndex(mark, paint);
    const outside = [];
    for (let y = 0; y <= fh; y += 0.5) {
      const hit = pickDot(index, 0, y, 0);
      if (hit && hit.px < 0) outside.push(hit);
    }
    expect(outside.length).toBeGreaterThan(0);
    expect(pickDot(index, -0.01, fh / 2, MAX_RADIUS)).toBeNull();
    expect(pickDot(index, fw + 0.01, fh / 2, MAX_RADIUS)).toBeNull();
    expect(pickDot(index, fw / 2, fh + 1, MAX_RADIUS)).toBeNull();
  });

  it('gives the small dot drawn over a big one, and the big one when it is drawn last', () => {
    const pair = [{ a: 50, b: 25, size: 1 }, { a: 50, b: 25, size: 20 }, { a: 0, b: 0, size: 5 }, { a: 100, b: 50, size: 5 }];
    const pickCenter = mark => {
      const { sx, sy, frame } = mark.lastPaint;
      return pickDot(buildPickIndex(mark, mark.lastPaint), sx.apply(50) - frame.fx + frame.offset, sy.apply(25) - frame.fy + frame.offset, MAX_RADIUS);
    };
    expect(pickCenter(painted(pair, { x: 'a', y: 'b', r: 'size' }).mark).j).toBe(0);
    expect(pickCenter(painted(pair, { x: 'a', y: 'b', r: 'size', sort: null }).mark).j).toBe(1);
  });

  it('finds nothing when the dots are invisible', () => {
    for (const options of [{ opacity: 0 }, { fill: 'none' }]) {
      const { mark } = painted(rows, { x: 'a', y: 'b', r: 4, ...options });
      const index = buildPickIndex(mark, mark.lastPaint);
      expect(index.idx).toHaveLength(0);
      expect(pickDot(index, mark.lastPaint.frame.fw / 2, mark.lastPaint.frame.fh / 2, MAX_RADIUS)).toBeNull();
    }
  });
});
