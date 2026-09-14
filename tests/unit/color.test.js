import { describe, it, expect } from 'vitest';
import { parseColor, paletteFromValues, paletteFromScale } from '../../src/color.js';

describe('color', () => {
  it('parses CSS colors to unit RGBA', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseColor('rgba(0, 0, 255, 0.5)')).toEqual([0, 0, 1, 0.5]);
    expect(parseColor('none')[3]).toBe(0);
    expect(parseColor('currentColor')).toEqual([0, 0, 0, 1]);
  });

  it('builds a 256-entry palette from mapped fill strings', () => {
    const p = paletteFromValues(['red', '#00ff00', 'rgba(0,0,255,0.5)'], 3);
    expect(p.length).toBe(1024);
    expect(Array.from(p.subarray(0, 12))).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128]);
    expect(p[12 + 3]).toBe(0);
  });

  it('lays out more than 256 colors in rows of 256', () => {
    const colors = Array.from({ length: 300 }, (_, i) => (i === 299 ? '#0000ff' : 'red'));
    const p = paletteFromValues(colors, 300);
    expect(p.length).toBe(256 * 2 * 4);
    expect(Array.from(p.subarray(299 * 4, 300 * 4))).toEqual([0, 0, 255, 255]);
    expect(p[300 * 4 + 3]).toBe(0);
  });
});

describe('color: browser-resolved strings', () => {
  it('falls back to black without a document', () => {
    expect(parseColor('var(--accent)')).toEqual([0, 0, 0, 1]);
  });
});


describe('color: continuous palette', () => {
  it('samples the scale at each bin center', () => {
    const scale = { apply: v => `rgb(${Math.round(v)}, 0, 0)` };
    const p = paletteFromScale(scale, [0, 254], 254);
    expect(p[0]).toBe(1);          // bin 0 center is 0.5 -> rounds to 1
    expect(p[253 * 4]).toBe(254);
    expect(p[253 * 4 + 3]).toBe(255);
    expect(p[254 * 4 + 3]).toBe(0); // the two kept-back entries stay transparent
  });
});
