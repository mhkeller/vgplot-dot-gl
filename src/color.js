import { color as parse } from 'd3-color';

/**
 * Colors reach us from Observable Plot as CSS strings: constants as you wrote
 * them, categories as the plot's color scale mapped them. This file only turns
 * those strings into red, green, blue and alpha.
 */

const BLACK = [0, 0, 0, 1];

/**
 * A CSS color as [r, g, b, a] between 0 and 1. Strings d3-color can't read, such
 * as `var(--accent)` or `currentColor`, are handed to the browser to work out;
 * `context` (an element on the page) is where the browser looks them up. With
 * no page at all they come out black.
 */
export function parseColor(str, context) {
  if (str == null || str === 'none') return [0, 0, 0, 0];
  const c = (parse(str) ?? parse(resolveCSS(str, context)))?.rgb();
  if (!c) return BLACK;
  return [c.r / 255, c.g / 255, c.b / 255, c.opacity];
}

/** Ask the browser what a color string means. Returns an rgb()/rgba() string, or null. */
function resolveCSS(str, context) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
  const host = context?.isConnected ? context : document.body;
  if (!host) return null;
  const probe = document.createElement('span');
  probe.style.color = str;
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || null;
}

/**
 * A 256-color palette (one row of a 256×1 texture) from the colors Plot gave the
 * category rows. Entry i is the color of category i. Unused entries stay
 * transparent, which also hides rows whose category is not in the color domain.
 */
export function paletteFromValues(fillValues, count) {
  const out = new Uint8Array(256 * 4);
  const n = Math.min(count, 254, fillValues.length);
  for (let i = 0; i < n; ++i) {
    const c = parse(fillValues[i])?.rgb();
    if (!c) continue;
    out[i * 4] = c.r;
    out[i * 4 + 1] = c.g;
    out[i * 4 + 2] = c.b;
    out[i * 4 + 3] = Math.round(c.opacity * 255);
  }
  return out;
}

/**
 * A palette for a number column: `levels` colors read off the plot's color scale
 * between the lowest and highest value, so a step number looks up the color of
 * its value. Any kind of color scale works, because the scale itself is asked
 * for each color.
 */
export function paletteFromScale(colorScale, [min, max], levels) {
  const out = new Uint8Array(256 * 4);
  const span = max - min;
  for (let i = 0; i < levels; ++i) {
    const v = span > 0 ? min + ((i + 0.5) / levels) * span : min;
    const c = parse(colorScale.apply(v))?.rgb();
    if (!c) continue;
    out[i * 4] = c.r;
    out[i * 4 + 1] = c.g;
    out[i * 4 + 2] = c.b;
    out[i * 4 + 3] = Math.round(c.opacity * 255);
  }
  return out;
}
