import { getSharedGL } from '../shared-gl.js';
import { transformFor, affine, axisAffine } from '../scale-map.js';

const SCRATCH = new Uint8Array(4);

/** The lowest pixel ratio a lower-resolution frame may use while you zoom. */
const MIN_REDUCED_DPR = 1;

/**
 * The WebGL painter. The point data is sent to the graphics card once per query
 * result, and again if a scale changes type, the center moves after a deep zoom,
 * or the context is lost. After that each frame is a few numbers, one draw call,
 * and a copy into the mark's canvas.
 */

function scaleKey(sx, sy, sr) {
  const part = s => (s ? `${s.type}:${s.exponent ?? ''}:${s.constant ?? ''}` : '-');
  return `${part(sx)}|${part(sy)}|${part(sr)}`;
}

/** Middle of the data range after the scale's curve (log, sqrt, ...) is applied. Subtracting it keeps the 32-bit float values small and precise. */
function center(T, extent) {
  const a = T(+extent[0]);
  const b = T(+extent[1]);
  if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  if (Number.isFinite(b)) return b;
  if (Number.isFinite(a)) return a;
  return 0;
}

export function freeGPU(mark) {
  const gpu = mark.gpu;
  mark.gpu = null;
  if (!gpu) return;
  const { shared } = gpu;
  shared.refs.delete(mark);
  if (gpu.generation !== shared.generation || shared.lost) return; // the data died with the old context
  const { gl } = shared;
  for (const b of gpu.buffers) gl.deleteBuffer(b);
  gl.deleteVertexArray(gpu.vao);
}

/** 32-bit floats have about seven digits. When rounding would move dots by more than this many pixels, we re-center. */
const MAX_DRIFT_PX = 0.1;
const FLOAT32_EPS = 6e-8;

/**
 * Which center to subtract before sending data up. Normally the middle of the
 * data range. When you have zoomed in so far that 32-bit rounding of the centered
 * values would move dots by a visible fraction of a pixel, the middle of what is
 * on screen is used instead. That costs one more upload. A category axis always
 * uses the middle of its codes, which are small integers that 32-bit floats hold exactly.
 */
function centersFor(mark, sx, sy) {
  const { prep, gpu } = mark;
  const tx = transformFor(sx, 'x');
  const ty = transformFor(sy, 'y');
  let cx = gpu && !prep.xCats ? gpu.cx : center(tx, prep.extent.x);
  let cy = gpu && !prep.yCats ? gpu.cy : center(ty, prep.extent.y);
  if (gpu) {
    const drift = (T, s, c) => {
      const mid = (T(+s.domain[0]) + T(+s.domain[1])) / 2;
      if (!Number.isFinite(mid)) return null;
      const { a } = affine(s, 0, 0);
      return Math.abs(mid - c) * FLOAT32_EPS * Math.abs(a) > MAX_DRIFT_PX ? mid : null;
    };
    const nx = prep.xCats ? null : drift(tx, sx, cx);
    const ny = prep.yCats ? null : drift(ty, sy, cy);
    if (nx != null) cx = nx;
    if (ny != null) cy = ny;
  }
  return { cx, cy };
}

function upload(mark, shared, sx, sy, sr) {
  const { cx, cy } = centersFor(mark, sx, sy);
  const key = `${scaleKey(sx, sy, sr)}|${cx}|${cy}`;
  const { gpu, prep, data } = mark;
  if (gpu && gpu.shared === shared && gpu.data === data && gpu.prep === prep && gpu.key === key && gpu.generation === shared.generation) return gpu;
  freeGPU(mark);

  const t0 = performance.now();
  const { gl } = shared;
  const columns = data.columns;
  const column = name => {
    const f = mark.channelField(name, { exact: true });
    return f ? columns[f.as] : null;
  };
  const X = column('x');
  const Y = column('y');
  const R = sr ? column('r') : null;
  const tx = transformFor(sx, 'x');
  const ty = transformFor(sy, 'y');
  const tr = R ? transformFor(sr, 'r') : null;

  const { n, perm, codes, hidden } = prep;
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  const fr = R ? new Float32Array(n) : null;
  const cat = new codes.constructor(n);
  let sumR = 0;
  for (let i = 0; i < n; ++i) {
    const j = perm[i];
    const vx = tx(+X[j]) - cx;
    const vy = ty(+Y[j]) - cy;
    let ok = Number.isFinite(vx) && Number.isFinite(vy);
    if (fr) {
      const vr = tr(+R[j]);
      ok = ok && Number.isFinite(vr);
      fr[i] = ok ? vr : 0;
      if (ok) sumR += vr;
    }
    fx[i] = ok ? vx : 0;
    fy[i] = ok ? vy : 0;
    cat[i] = ok ? codes[j] : hidden;
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  shared.bindQuad();
  const buffers = [shared.attrib(1, fx), shared.attrib(2, fy), shared.attrib(4, cat, cat instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE)];
  if (fr) buffers.push(shared.attrib(3, fr));
  else {
    gl.disableVertexAttribArray(3);
    gl.vertexAttrib1f(3, 0);
  }
  gl.bindVertexArray(null);

  mark.gpu = { shared, vao, buffers, n, cx, cy, hasR: !!fr, meanT: n ? sumR / n : 0, key, data, prep, generation: shared.generation, uploadMs: performance.now() - t0 };
  shared.refs.add(mark);
  return mark.gpu;
}

/**
 * How many pixels a frame will paint: dots times the area of their squares.
 * This number decides whether the mark draws at a lower resolution while you zoom, which keeps dense plots smooth.
 */
function estimateFragments(gpu, sr, style, dpr) {
  let r = style.r;
  if (gpu.hasR) {
    const ar = affine(sr, 0, 0, 'r');
    r = Math.max(0, ar.a * gpu.meanT + ar.b);
  }
  const side = 2 * r * dpr + 2;
  return gpu.n * side * side;
}

/**
 * @param {object} options
 * @param {boolean} [options.allowReduce] draw at a lower resolution when the
 *   estimated painting work is over the mark's budget (the mark then schedules
 *   a sharp repaint once zooming stops)
 */
export function paintGL(mark, canvas, { sx, sy, sr, lines, frame, style }, { allowReduce = false } = {}) {
  const shared = getSharedGL(mark.blit);
  if (shared.lost) {
    shared.refs.add(mark); // so the plot is redrawn too when the context comes back
    return { painter: 'gl', skipped: 'context lost' };
  }
  const t0 = performance.now();
  const gpu = upload(mark, shared, sx, sy, sr);
  const t1 = performance.now();
  const { gl, uniforms: u } = shared;
  const { fw, fh, offset, fx, fy } = frame;
  let { pw, ph, dpr } = frame;
  const estimate = estimateFragments(gpu, sr, style, dpr);
  if (allowReduce && estimate > mark.fragmentBudget) {
    dpr = Math.max(MIN_REDUCED_DPR, dpr * Math.sqrt(mark.fragmentBudget / estimate));
    pw = Math.max(1, Math.round(fw * dpr));
    ph = Math.max(1, Math.round(fh * dpr));
  }
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  const ax = axisAffine(sx, lines.x, gpu.cx, -fx, 'x');
  const ay = axisAffine(sy, lines.y, gpu.cy, -fy, 'y');
  shared.beginPlot(pw, ph);
  gl.bindVertexArray(gpu.vao);
  gl.uniform2f(u.ax, ax.a, ax.b);
  gl.uniform2f(u.ay, ay.a, ay.b);
  gl.uniform2f(u.res, pw, ph);
  gl.uniform1f(u.dpr, dpr);
  gl.uniform1f(u.offset, offset);
  gl.uniform1f(u.opacity, style.opacity);
  gl.uniform1f(u.hidden, gpu.prep.hidden);
  if (gpu.hasR) {
    const ar = affine(sr, 0, 0, 'r');
    gl.uniform4f(u.r, 1, ar.a, ar.b, 0);
  } else {
    gl.uniform4f(u.r, 0, 0, 0, style.r);
  }
  if (style.palette) {
    shared.setPalette(style.palette, style.palette.length / (256 * 4));
    gl.uniform1i(u.colorMode, 1);
  } else {
    gl.uniform1i(u.colorMode, 0);
    gl.uniform4fv(u.color, style.fillRGBA);
  }
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, gpu.n);
  gl.bindVertexArray(null);
  // gl.finish() doesn't reliably wait in Chrome; reading one pixel back does.
  if (mark.benchmark) gl.readPixels(0, shared.height - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, SCRATCH);
  const t2 = performance.now();
  shared.blitTo(canvas, pw, ph);
  const t3 = performance.now();
  return { painter: 'gl', drawn: gpu.n, uploadMs: t1 - t0, drawMs: t2 - t1, blitMs: t3 - t2, dpr, reduced: dpr < frame.dpr, estimate };
}
