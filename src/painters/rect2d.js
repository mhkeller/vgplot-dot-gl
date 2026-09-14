import { transformFor, affine, axisAffine } from '../scale-map.js';

/**
 * A plain 2D canvas painter: one filled square per dot, in the same draw order
 * as the WebGL painter. It is the fallback when the browser has no WebGL2, and
 * the tests use it to check that the plot is hooked up right, so it has to put
 * dots exactly where the WebGL painter does.
 */
export function paintRect2D(mark, canvas, { sx, sy, sr, lines, frame, style }) {
  const t0 = performance.now();
  const { prep, data } = mark;
  const { pw, ph, dpr, offset, fx, fy } = frame;
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);

  const column = name => {
    const f = mark.channelField(name, { exact: true });
    return f ? data.columns[f.as] : null;
  };
  const X = column('x');
  const Y = column('y');
  const R = sr ? column('r') : null;
  const tx = transformFor(sx, 'x');
  const ty = transformFor(sy, 'y');
  const tr = sr ? transformFor(sr, 'r') : null;
  const ax = axisAffine(sx, lines.x, 0, -fx, 'x');
  const ay = axisAffine(sy, lines.y, 0, -fy, 'y');
  const ar = sr ? affine(sr, 0, 0, 'r') : null;
  const rConst = style.r;

  const rgba = c => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
  const palette = style.palette
    ? Array.from({ length: prep.levels }, (_, i) => rgba([style.palette[i * 4] / 255, style.palette[i * 4 + 1] / 255, style.palette[i * 4 + 2] / 255, style.palette[i * 4 + 3] / 255]))
    : null;
  const constant = rgba(style.fillRGBA);

  ctx.globalAlpha = style.opacity;
  let current = null;
  const { perm, codes, hidden, n } = prep;
  let drawn = 0;
  for (let i = 0; i < n; ++i) {
    const j = perm[i];
    const code = codes[j];
    if (code === hidden) continue;
    const px = ax.a * tx(+X[j]) + ax.b + offset;
    const py = ay.a * ty(+Y[j]) + ay.b + offset;
    const r = R ? ar.a * tr(+R[j]) + ar.b : rConst;
    if (!(r > 0) || !Number.isFinite(px) || !Number.isFinite(py)) continue;
    const fill = palette ? palette[code] : constant;
    if (fill !== current) ctx.fillStyle = current = fill;
    const s = r * dpr;
    ctx.fillRect(px * dpr - s, py * dpr - s, 2 * s, 2 * s);
    ++drawn;
  }
  return { painter: 'rect2d', drawn, drawMs: performance.now() - t0 };
}
