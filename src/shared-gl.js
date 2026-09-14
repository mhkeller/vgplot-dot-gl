import { VERTEX, FRAGMENT, UNIFORMS } from './shaders.js';

/**
 * One WebGL context for the whole page. Every dot mark draws its points here and
 * then copies the picture into its own small canvas inside its plot. Sharing one
 * context keeps a page full of plots well under the browser's limit on how many
 * WebGL contexts can be alive at once.
 *
 * There are two ways to copy the picture out. The first mark that asks picks one:
 * - 'drawImage': a plain canvas that isn't on the page; each plot's 2D canvas
 *   draws from it.
 * - 'bitmaprenderer': an OffscreenCanvas; each frame is handed over as an
 *   ImageBitmap. This one exists to measure browsers where drawImage from a
 *   WebGL canvas is slow.
 */

// Two library copies on one page share this record, so bump the number when the shaders, the attribute layout or the state object's methods change.
const KEY = Symbol.for('vgplot-dot-gl/shared-gl@1');

/**
 * The page-wide record, made the first time it is read. `generation` counts contexts and context
 * losses over the life of the page, so data left over from an old context is never used as if it were still there.
 */
const page = () => (globalThis[KEY] ??= { shared: null, unsupported: false, generation: 0 });

const CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`dotGL: shader failed to compile: ${log}`);
  }
  return shader;
}

function buildProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`dotGL: program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = {};
  for (const name of UNIFORMS) uniforms[name.slice(2)] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function setup(state) {
  const { gl } = state;
  Object.assign(state, buildProgram(gl));
  state.quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
  gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
  state.palette = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, state.palette);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 4));
  state.width = 0;
  state.height = 0;
}

/**
 * The shared context, made the first time someone asks. Returns null when the
 * browser has no WebGL2, so the caller can use another painter.
 * @param {'drawImage'|'bitmaprenderer'} [blit]
 */
export function getSharedGL(blit = 'drawImage') {
  const record = page();
  if (record.shared) return record.shared;
  if (record.unsupported || typeof document === 'undefined') return null;
  const offscreen = blit === 'bitmaprenderer' && typeof OffscreenCanvas !== 'undefined';
  const canvas = offscreen ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false
  });
  if (!gl) {
    record.unsupported = true;
    return null;
  }
  const state = {
    canvas,
    gl,
    blit: offscreen ? 'bitmaprenderer' : 'drawImage',
    /** Marks that currently have data stored here. */
    refs: new Set(),
    /** Goes up when the context is lost, so we know the stored data is gone. */
    generation: ++record.generation,
    lost: false,
    maxSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)
  };
  setup(state);

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    state.lost = true;
    state.generation = ++page().generation;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    setup(state);
    state.lost = false;
    for (const mark of state.refs) mark.plot?.update();
  });

  /** Make the drawing area big enough for a plot of this size (in device pixels). */
  state.ensureSize = (pw, ph) => {
    const w = Math.min(state.maxSize, offscreen ? pw : Math.max(state.width, pw));
    const h = Math.min(state.maxSize, offscreen ? ph : Math.max(state.height, ph));
    if (w !== state.width || h !== state.height || canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      state.width = w;
      state.height = h;
    }
  };

  /** Clear a plot-sized area in the top-left corner and set up blending. */
  state.beginPlot = (pw, ph) => {
    state.ensureSize(pw, ph);
    gl.viewport(0, state.height - ph, pw, ph);
    gl.scissor(0, state.height - ph, pw, ph);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(state.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.palette);
    gl.uniform1i(state.uniforms.palette, 0);
  };

  /** Send up a 256-color palette. */
  state.setPalette = rgba => {
    gl.bindTexture(gl.TEXTURE_2D, state.palette);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  };

  /** One number per dot, stored on the graphics card and wired to `location` in the current vertex array. */
  state.attrib = (location, array, type = gl.FLOAT) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 1, type, false, 0, 0);
    gl.vertexAttribDivisor(location, 1);
    return buffer;
  };

  /** Wire the square's corners to slot 0 (one per vertex, not per dot). */
  state.bindQuad = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
  };

  /** Copy the plot-sized area into the mark's own canvas. */
  state.blitTo = (target, pw, ph) => {
    if (offscreen) {
      const bitmap = canvas.transferToImageBitmap();
      target.getContext('bitmaprenderer').transferFromImageBitmap(bitmap);
      return;
    }
    const ctx = target.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(canvas, 0, 0, pw, ph, 0, 0, pw, ph);
  };

  record.shared = state;
  return state;
}

/** Let go of the shared context. For tests and page teardown; live marks send their data again on their next draw. */
export function disposeSharedGL() {
  const record = page();
  const state = record.shared;
  if (!state) return;
  for (const mark of Array.from(state.refs)) mark.gpu = null;
  state.refs.clear();
  state.generation = ++record.generation;
  state.gl.getExtension('WEBGL_lose_context')?.loseContext();
  record.shared = null;
}
