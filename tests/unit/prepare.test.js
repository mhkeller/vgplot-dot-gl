import { describe, it, expect } from 'vitest';
import { quantile } from 'd3-array';
import { prepare } from '../../src/prepare.js';

function rows(n, seed = 1) {
  let s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const r = new Float64Array(n);
  const fill = new Array(n);
  const cats = ['R', 'D', 'I', 'G'];
  for (let i = 0; i < n; ++i) {
    x[i] = rand() * 1000 - 200;
    y[i] = rand() * 50;
    r[i] = rand() * 90 + 10;
    fill[i] = cats[Math.floor(rand() * cats.length)];
  }
  return { x, y, r, fill };
}

describe('prepare', () => {
  it('finds the lowest and highest values, sorts the categories and gives each row the right code', () => {
    const { x, y, r, fill } = rows(5000);
    const p = prepare({ x, y, r, fill });
    expect(p.n).toBe(5000);
    expect(p.cats).toEqual(['D', 'G', 'I', 'R']);
    expect(p.extent.x[0]).toBe(Math.min(...x));
    expect(p.extent.x[1]).toBe(Math.max(...x));
    for (let i = 0; i < 5000; i += 97) expect(p.cats[p.codes[i]]).toBe(fill[i]);
    expect(p.k).toBe(4);
    expect(p.hints.x).toHaveLength(4);
    expect(p.hints.fill).toEqual(['D', 'G', 'I', 'R']);
    // Smallest positive value first (for log scales), true minimum last, maximum in between.
    expect(p.hints.x[0]).toBe(Math.min(...Array.from(x).filter(v => v > 0)));
    expect(p.hints.x[1]).toBe(p.extent.x[1]);
    expect(p.hints.x[p.k - 1]).toBe(p.extent.x[0]);
    expect(Math.min(...p.hints.x)).toBe(p.extent.x[0]);
    expect(Math.max(...p.hints.x)).toBe(p.extent.x[1]);
    expect(p.hints.r[0]).toBe(p.extent.r[0]);
    expect(p.hints.r[1]).toBe(p.extent.r[1]);
  });

  it('draws big dots first, within a bin of tolerance', () => {
    const { x, y, r, fill } = rows(3000);
    const p = prepare({ x, y, r, fill });
    const tolerance = (p.extent.r[1] - p.extent.r[0]) / 1023 + 1e-9;
    for (let i = 1; i < p.n; ++i) expect(r[p.perm[i - 1]]).toBeGreaterThanOrEqual(r[p.perm[i]] - tolerance);
  });

  it('keeps data order without a radius column or with sort null', () => {
    const { x, y, r } = rows(100);
    expect(Array.from(prepare({ x, y }).perm)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(Array.from(prepare({ x, y, r, sort: null }).perm)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('skips nulls, NaN and null categories, and marks them hidden', () => {
    const x = [1, null, 3, NaN, 5, 6];
    const y = [1, 2, 3, 4, 5, 6];
    const fill = ['a', 'a', 'b', 'b', null, 'b'];
    const p = prepare({ x, y, fill });
    expect(p.n).toBe(3);
    expect(Array.from(p.perm)).toEqual([0, 2, 5]);
    expect(Array.from(p.codes)).toEqual([0, 255, 1, 255, 255, 1]);
    expect(p.extent.x).toEqual([1, 6]);
  });

  it('uses code 0 for every valid row when there is no fill column', () => {
    const p = prepare({ x: [1, 2, null], y: [1, 2, 3] });
    expect(Array.from(p.codes)).toEqual([0, 0, 255]);
    expect(p.hints.fill).toBeNull();
  });

  it('keeps Date hints as Dates so Plot picks a time scale', () => {
    const x = [new Date(2020, 0, 1), new Date(2021, 0, 1)];
    const p = prepare({ x, y: [1, 2] });
    expect(p.hints.x[0]).toBeInstanceOf(Date);
    expect(+p.hints.x[1]).toBe(+x[1]);
  });

  it('rejects too many categories', () => {
    const fill = Array.from({ length: 300 }, (_, i) => `c${i}`);
    expect(() => prepare({ x: fill.map((_, i) => i), y: fill.map(() => 0), fill })).toThrow(/distinct/);
  });

  it('pads the radius hint so a quarter of its values sit below the same radius as in the data', () => {
    const { x, y, r } = rows(20000);
    const p = prepare({ x, y, r, wantP25: true });
    expect(p.k).toBe(8);
    const fromHints = quantile(p.hints.r, 0.25);
    const fromData = quantile(Array.from(r), 0.25);
    expect(Math.abs(fromHints - fromData) / fromData).toBeLessThan(0.02);
  });
});

describe('prepare: review fixes', () => {
  it('puts the smallest positive value first so log scales ignore zeros and negatives', () => {
    const p = prepare({ x: [5, 3, 0, 10, 7], y: [1, 2, 3, 4, 5] });
    expect(p.k).toBe(3);
    expect(p.hints.x[0]).toBe(3);
    expect(p.hints.x[1]).toBe(10);
    expect(p.hints.x[p.k - 1]).toBe(0);
    const q = prepare({ x: [-1, 3, 10], y: [1, 2, 3] });
    expect(q.hints.x).toEqual([3, 10, -1]);
  });

  it('takes the lowest and highest x and y from every number in the column, even rows it cannot draw', () => {
    const p = prepare({ x: [1, 1000], y: [1, null] });
    expect(p.n).toBe(1);
    expect(p.extent.x).toEqual([1, 1000]);
    expect(p.hints.x.slice(0, 2)).toEqual([1, 1000]);
  });

  it('works out the 25th-percentile radius from positive radii only, also with sort null', () => {
    const n = 8000;
    const r = new Float64Array(n);
    for (let i = 0; i < n; ++i) r[i] = i < n / 3 ? 0 : (i % 100) + 1; // a third are zero
    const x = new Float64Array(n).fill(1), y = new Float64Array(n).fill(1);
    for (const sort of ['-r', null]) {
      const p = prepare({ x, y, r, sort, wantP25: true });
      const positive = Array.from(r).filter(v => v > 0).sort((a, b) => a - b);
      const expected = quantile(positive, 0.25);
      expect(Math.abs(p.p25 - expected) / expected).toBeLessThan(0.02);
      expect(quantile(p.hints.r.filter(v => v > 0), 0.25)).toBeCloseTo(p.p25, 6);
      expect(p.n).toBe(n);
    }
  });

  it('clamps maxCategories so codes never wrap a byte', () => {
    const fill = Array.from({ length: 300 }, (_, i) => `c${i}`);
    expect(() => prepare({ x: fill.map((_, i) => i), y: fill.map(() => 0), fill, maxCategories: 300 })).toThrow(/254/);
  });
});


describe('prepare: fill modes', () => {
  it('uses precomputed codes and rejects codes outside the category list', () => {
    const p = prepare({ x: [1, 2, 3, 4], y: [1, 2, 3, 4], fill: Uint8Array.from([0, 2, 255, 7]), fillCats: ['a', 'b', 'c'] });
    expect(Array.from(p.codes)).toEqual([0, 2, 255, 255]);
    expect(p.hidden).toBe(255);
    expect(p.n).toBe(2);
    expect(p.cats).toEqual(['a', 'b', 'c']);
    expect(p.hints.fill).toEqual(['a', 'b', 'c']);
  });

  it('uses two-byte codes with 65535 as the hidden code above 254 fill categories', () => {
    const fillCats = Array.from({ length: 300 }, (_, i) => `c${i}`);
    const fill = Uint16Array.from([0, 299, 65535, 150, 12]);
    const p = prepare({ x: [1, 2, 3, 4, NaN], y: [1, 2, 3, 4, 5], fill, fillCats });
    expect(p.codes).toBeInstanceOf(Uint16Array);
    expect(p.hidden).toBe(65535);
    expect(Array.from(p.codes)).toEqual([0, 299, 65535, 150, 65535]);
    expect(p.n).toBe(3);
    expect(p.levels).toBe(300);
    expect(p.k).toBe(300);
    expect(p.hints.fill[299]).toBe('c299');
  });

  it('splits a number fill into 254 steps between its lowest and highest value', () => {
    const fill = new Float64Array([0, 25, 50, 75, 100, NaN]);
    const p = prepare({ x: [1, 2, 3, 4, 5, 6], y: [1, 1, 1, 1, 1, 1], fill, continuous: true });
    expect(Array.from(p.codes)).toEqual([0, 63, 127, 190, 253, 255]);
    expect(p.extent.fill).toEqual([0, 100]);
    expect(p.hints.fill.slice(0, 2)).toEqual([0, 100]);
    expect(p.levels).toBe(254);
    expect(p.continuous).toBe(true);
    expect(p.codes).toBeInstanceOf(Uint8Array);
    expect(p.hidden).toBe(255);
  });

  it('keeps Date legend hints for a date fill that arrives as epoch milliseconds', () => {
    const fill = Float64Array.from([Date.UTC(2020, 0, 1), Date.UTC(2020, 6, 1), Date.UTC(2021, 0, 1)]);
    const p = prepare({ x: [1, 2, 3], y: [1, 2, 3], fill, continuous: true, dates: { fill: true } });
    expect(p.hints.fill[0]).toBeInstanceOf(Date);
    expect(p.hints.fill.map(Number).slice(0, 2)).toEqual([Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1)]);
    expect(Array.from(p.codes)).toEqual([0, 126, 253]);
  });
});

describe('prepare: category axes and dates', () => {
  it('gives a code axis its category list as hints and the code range as its extent', () => {
    const x = Uint8Array.from([0, 2, 1, 255, 2]);
    const y = Uint16Array.from([1, 0, 0, 1, 65535]);
    const p = prepare({ x, y, xCats: ['a', 'b', null], yCats: ['no', 'yes'] });
    expect(p.n).toBe(3);
    expect(Array.from(p.perm)).toEqual([0, 1, 2]);
    expect(p.extent.x).toEqual([0, 2]);
    expect(p.extent.y).toEqual([0, 1]);
    expect(p.k).toBe(3);
    expect(p.hints.x).toEqual(['a', 'b', null]);
    // Padded to k by repeating the last entry, so Plot sees the same list.
    expect(p.hints.y).toEqual(['no', 'yes', 'yes']);
    expect(p.xCats).toEqual(['a', 'b', null]);
  });

  it('makes k cover the longest category list and keeps null last in the padded hints', () => {
    const xCats = Array.from({ length: 40 }, (_, i) => `x${i}`).concat([null]);
    const p = prepare({ x: Uint8Array.from([40, 3]), y: [-1, 2], xCats, r: [1, 2], wantP25: true });
    expect(p.k).toBe(41);
    expect(p.hints.x.at(-1)).toBeNull();
    expect(p.hints.x.slice(0, 41)).toEqual(xCats);
    // A code axis has no log-scale slot; y still gets its smallest positive value first.
    expect(p.hints.y[0]).toBe(2);
    expect(p.hints.y[p.k - 1]).toBe(-1);
  });

  it('turns epoch-millisecond columns flagged as dates into Date hints', () => {
    const x = Float64Array.from([Date.UTC(2020, 0, 1), NaN, Date.UTC(2024, 0, 1)]);
    const p = prepare({ x, y: [1, 2, 3], dates: { x: true } });
    expect(p.n).toBe(2);
    expect(p.hints.x[0]).toBeInstanceOf(Date);
    expect(+p.hints.x[1]).toBe(Date.UTC(2024, 0, 1));
    expect(p.extent.x).toEqual([Date.UTC(2020, 0, 1), Date.UTC(2024, 0, 1)]);
    expect(prepare({ x, y: [1, 2, 3] }).hints.x[0]).toBe(Date.UTC(2020, 0, 1));
  });
});
