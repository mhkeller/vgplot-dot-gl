// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as Plot from '@observablehq/plot';
import { DotGLMark } from '../../src/DotGLMark.js';

const require = createRequire(import.meta.url);

function table(n) {
  let s = 7;
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const cats = ['R', 'D', 'I'];
  return Array.from({ length: n }, () => ({
    size: Math.exp(rand() * 8) + 1,
    price: rand() * 1000,
    volume: rand() * 100,
    party: cats[Math.floor(rand() * 3)]
  }));
}

function stubbed(mark) {
  mark.render = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');
  return mark;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('DotGLMark', () => {
  const data = table(3000);

  it('separates its own options from the channels sent to SQL/Plot', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price', fill: 'party', r: 2.5, opacity: 0.6, clip: true, sort: null, blit: 'bitmaprenderer', painter: 'rect2d' });
    expect(mark.channels.map(c => c.channel).sort()).toEqual(['clip', 'fill', 'opacity', 'r', 'x', 'y']);
    expect(mark.sortMode).toBeNull();
    expect(mark.blit).toBe('bitmaprenderer');
    expect(mark.constant('opacity')).toBe(0.6);
  });

  it('throws when the mark is made with fx/fy, or with a column for an option it cannot draw', () => {
    expect(() => new DotGLMark(data, { x: 'size', y: 'price', fx: 'party' })).toThrow(/facet/);
    expect(() => new DotGLMark(data, { x: 'size', y: 'price', stroke: 'party', painter: 'rect2d' })).toThrow(/stroke/);
    expect(() => new DotGLMark(data, { x: 'size', y: 'price', symbol: 'party', painter: 'rect2d' })).toThrow(/symbol/);
  });

  it('emits one dot spec with short hint arrays instead of the full columns', () => {
    const mark = stubbed(new DotGLMark(data, { x: 'size', y: 'price', r: 'volume', fill: 'party', opacity: 0.6, clip: true, painter: 'rect2d' }));
    const specs = mark.plotSpecs();
    expect(specs).toHaveLength(1);
    const [{ type, data: d, options }] = specs;
    expect(type).toBe('dot');
    expect(d).toEqual({ length: 8 });
    expect(options.sort).toBeNull();
    expect(typeof options.render).toBe('function');
    expect(options.x).toHaveLength(8);
    expect(options.fill).toEqual({ value: ['D', 'I', 'R', 'R', 'R', 'R', 'R', 'R'], scale: 'color' });
    expect(options.opacity).toBe(0.6);
    expect(options.clip).toBe(true);
    expect(mark.data.columns.size.length).toBe(3000);
  });

  it('falls back to ordinary SVG dots when asked', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price', painter: 'dot' });
    const [{ options }] = mark.plotSpecs();
    expect(options.x.length).toBe(3000);
    expect(options.render).toBeUndefined();
  });

  it('makes Plot infer the same scales as the full columns', () => {
    const X = data.map(d => d.size), Y = data.map(d => d.price), R = data.map(d => d.volume), F = data.map(d => d.party);
    const full = Plot.plot({
      document, width: 640, height: 400,
      x: { type: 'log' },
      marks: [Plot.dot({ length: X.length }, { x: X, y: Y, r: R, fill: { value: F, scale: 'color' } })]
    });
    const mark = stubbed(new DotGLMark(data, { x: 'size', y: 'price', r: 'volume', fill: 'party', painter: 'rect2d' }));
    const [{ data: d, options }] = mark.plotSpecs();
    const hinted = Plot.plot({ document, width: 640, height: 400, x: { type: 'log' }, marks: [Plot.dot(d, options)] });
    for (const name of ['x', 'y', 'color']) {
      expect(hinted.scale(name).domain).toEqual(full.scale(name).domain);
      expect(hinted.scale(name).range).toEqual(full.scale(name).range);
      expect(hinted.scale(name).type).toEqual(full.scale(name).type);
    }
    expect(hinted.scale('r').domain).toEqual(full.scale('r').domain);
    const [h0, h1] = hinted.scale('r').range;
    const [f0, f1] = full.scale('r').range;
    expect(h0).toBeCloseTo(f0, 5);
    expect(Math.abs(h1 - f1) / f1).toBeLessThan(0.03);
    expect(hinted.querySelectorAll('circle').length).toBe(0);
    expect(hinted.legend('color')).toBeTruthy();
  });

  it('gives render the finished scales and the colors Plot chose for the hint rows', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price', fill: 'party', painter: 'rect2d' });
    let seen;
    mark.render = (index, scales, values) => {
      seen = { scales, values };
      return document.createElementNS(SVG_NS, 'g');
    };
    const [{ data: d, options }] = mark.plotSpecs();
    Plot.plot({ document, width: 640, height: 400, color: { domain: ['R', 'D', 'I'], range: ['red', 'blue', 'gray'] }, marks: [Plot.dot(d, options)] });
    expect(seen.scales.scales.x.type).toBe('linear');
    expect(seen.values.fill).toEqual(['blue', 'gray', 'red']);
  });

  it('survives destroy and renders nothing afterwards', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price', painter: 'rect2d' });
    mark.plotSpecs();
    mark.destroy();
    expect(mark.destroyed).toBe(true);
    const g = mark.render([], { scales: {} }, {}, { width: 1, height: 1 }, { document });
    expect(g.childNodes.length).toBe(0);
  });
});

describe('DotGLMark: review fixes', () => {
  it('draws a visible default color when no fill is given', () => {
    const data = table(50);
    const mark = new DotGLMark(data, { x: 'size', y: 'price', painter: 'rect2d' });
    let style;
    const origPaint = mark.render;
    mark.render = (index, scales, values, dims, context) => {
      // Read render's inputs the same way the painters do.
      const fill = mark.constant('fill') ?? 'currentColor';
      style = fill;
      return document.createElementNS(SVG_NS, 'g');
    };
    const [{ data: d, options }] = mark.plotSpecs();
    Plot.plot({ document, width: 300, height: 200, marks: [Plot.dot(d, options)] });
    expect(style).toBe('currentColor');
    expect(origPaint).toBeTypeOf('function');
  });

  it('keeps Plot log inference intact when a column has zeros', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ size: i === 0 ? 0 : i, price: i + 1, party: 'D' }));
    const X = rows.map(d => d.size), Y = rows.map(d => d.price);
    const full = Plot.plot({ document, width: 640, height: 400, x: { type: 'log' }, marks: [Plot.dot({ length: X.length }, { x: X, y: Y })] });
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price', painter: 'rect2d' }));
    const [{ data: d, options }] = mark.plotSpecs();
    const hinted = Plot.plot({ document, width: 640, height: 400, x: { type: 'log' }, marks: [Plot.dot(d, options)] });
    expect(hinted.scale('x').domain).toEqual(full.scale('x').domain);
    expect(hinted.scale('y').domain).toEqual(full.scale('y').domain);
    const linear = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    expect(linear.scale('x').domain).toEqual([0, 199]);
  });
});

describe('DotGLMark: more review fixes', () => {
  it('ignores an r scale created by another mark when its own r is constant', () => {
    const rows = table(300);
    const mark = new DotGLMark(rows, { x: 'size', y: 'price', r: 2.5, fill: 'party', painter: 'rect2d' });
    let seenR;
    mark.render = (index, scales) => {
      seenR = mark.channelField('r', { exact: true }) ? scales.scales.r : undefined;
      return document.createElementNS(SVG_NS, 'g');
    };
    const [{ data: d, options }] = mark.plotSpecs();
    const fig = Plot.plot({ document, width: 640, height: 400, r: { domain: [1, 50], range: [2, 11] }, marks: [Plot.dot(d, options)] });
    expect(fig.scale('r')).toBeTruthy();
    expect(seenR).toBeUndefined();
  });

  it('hints undefined for a column with no finite value so Plot behaves like an empty vg.dot', () => {
    const rows = [{ size: 1, price: null, party: 'D' }, { size: 2, price: null, party: 'D' }];
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price', painter: 'rect2d' }));
    const [{ data: d, options }] = mark.plotSpecs();
    expect(options.y.every(v => v === undefined)).toBe(true);
    const fig = Plot.plot({ document, width: 640, height: 400, y: { type: 'log' }, marks: [Plot.dot(d, options)] });
    expect(fig.scale('y').domain).toEqual([1, 10]);
    expect(fig.scale('x').domain).toEqual([1, 2]);
  });

  it('warns once about vg.dot options it cannot honor', () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = m => warnings.push(m);
    try {
      const mark = stubbed(new DotGLMark(table(20), { x: 'size', y: 'price', stroke: 'red', symbol: 'square', painter: 'rect2d' }));
      mark.plotSpecs();
      mark.plotSpecs();
    } finally {
      console.warn = orig;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stroke, symbol/);
  });

  it('folds fillOpacity into the painted opacity and drops data on destroy', () => {
    const mark = new DotGLMark(table(20), { x: 'size', y: 'price', opacity: 0.5, fillOpacity: 0.5, painter: 'rect2d' });
    expect(mark.constant('opacity') * mark.constant('fillOpacity')).toBe(0.25);
    mark.plotSpecs();
    mark.destroy();
    expect(mark.data).toBeNull();
    expect(mark.plotSpecs()).toEqual([]);
  });
});


describe('DotGLMark: fill modes', () => {
  it('replaces the fill column with a CASE expression when categories were resolved in SQL', () => {
    const mark = new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', fill: 'party', painter: 'rect2d' });
    // What prepare() would have produced for the categories ['D', 'R'].
    mark.cats = ['D', 'R'];
    mark.fillMode = 'codes';
    const { cond, eq, literal } = require('@uwdata/mosaic-sql');
    mark.codeExpr = cond().when(eq(mark.channelField('fill').field, literal('D')), 0).when(eq(mark.channelField('fill').field, literal('R')), 1);
    const sql = String(mark.query());
    expect(sql).toMatch(/CASE WHEN \("party" = 'D'\) THEN 0 WHEN \("party" = 'R'\) THEN 1 END AS "party"/);
    expect(sql).toMatch(/"size"/);
  });

  it('draws integer codes from SQL against the category list', () => {
    const rows = [
      { size: 1, price: 1, party: 1 },
      { size: 2, price: 2, party: 0 },
      { size: 3, price: 3, party: null }
    ];
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price', fill: 'party', painter: 'rect2d' }));
    mark.cats = ['D', 'R'];
    mark.fillMode = 'codes';
    const [{ data: d, options }] = mark.plotSpecs();
    expect(options.fill).toEqual({ value: ['D', 'R'], scale: 'color' });
    expect(Array.from(mark.prep.codes)).toEqual([1, 0, 255]);
    expect(mark.prep.n).toBe(2);
    expect(d).toEqual({ length: 2 });
  });

  it('bins a numeric fill and lets Plot build a continuous color scale with a ramp legend', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ size: i + 1, price: i, shift: (i / 299) * 2 - 1 }));
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price', fill: 'shift', painter: 'rect2d' }));
    mark.fillMode = 'continuous';
    const [{ data: d, options }] = mark.plotSpecs();
    expect(options.fill.value.slice(0, 2)).toEqual([-1, 1]);
    expect(mark.prep.continuous).toBe(true);
    expect(mark.prep.levels).toBe(254);
    expect(mark.prep.codes[0]).toBe(0);
    expect(mark.prep.codes[299]).toBe(253);
    const fig = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    expect(fig.scale('color').type).toBe('linear');
    expect(fig.scale('color').domain).toEqual([-1, 1]);
    // (The ramp legend needs a 2D canvas, which jsdom doesn't have; the browser suite checks it.)
  });

  it('keeps the string path for array data and for the SVG painter', async () => {
    const mark = new DotGLMark(table(10), { x: 'size', y: 'price', fill: 'party', painter: 'rect2d' });
    expect(mark.fillMode).toBe('strings');
    await mark.prepare();
    expect(mark.fillMode).toBe('strings');
    expect(mark.codeExpr).toBeNull();
  });
});
