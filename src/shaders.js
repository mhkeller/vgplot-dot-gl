/**
 * Each dot is a small square made of two triangles, and the fragment shader cuts
 * a circle out of it with a one-pixel soft edge. The vertex shader places the
 * square in screen pixels from the per-dot values plus the per-frame scale
 * numbers. Colors are written with the alpha already multiplied in, so
 * overlapping dots add up the way see-through SVG circles do.
 *
 * Attribute slots: 0 corner (per vertex), 1 x, 2 y, 3 r, 4 category (per dot).
 * Category 255 hides the dot (null category, or a value the scale can't place).
 */

export const VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in float a_x;
layout(location = 2) in float a_y;
layout(location = 3) in float a_r;
layout(location = 4) in float a_cat;

uniform vec2 u_ax;         // px = a_x * u_ax.x + u_ax.y  (CSS pixels, measured from the frame's top-left)
uniform vec2 u_ay;
uniform vec2 u_res;        // canvas size in device pixels
uniform float u_dpr;
uniform float u_offset;    // Plot's half-pixel nudge on 1x displays
uniform vec4 u_r;          // x: 0 = one radius for all, 1 = per dot; y: a, z: b; w: the shared radius (CSS pixels)
uniform int u_colorMode;   // 0 = one color for all, 1 = look the color up in the palette
uniform vec4 u_color;
uniform sampler2D u_palette;

out vec2 v_p;
out float v_rpx;
out vec4 v_color;

void main() {
  float px = a_x * u_ax.x + u_ax.y + u_offset;
  float py = a_y * u_ay.x + u_ay.y + u_offset;
  float r = u_r.x < 0.5 ? u_r.w : (u_r.y * a_r + u_r.z);
  v_rpx = r * u_dpr;
  v_p = a_corner * (v_rpx + 1.0);
  vec2 c = vec2(px, py) * u_dpr + v_p;
  v_color = u_colorMode == 1 ? texelFetch(u_palette, ivec2(int(a_cat), 0), 0) : u_color;
  bool hide = r <= 0.0 || a_cat >= 254.5 || v_color.a <= 0.0;
  gl_Position = hide
    ? vec4(2.0, 2.0, 0.0, 1.0)
    : vec4(c.x / u_res.x * 2.0 - 1.0, 1.0 - c.y / u_res.y * 2.0, 0.0, 1.0);
}`;

export const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_p;
in float v_rpx;
in vec4 v_color;
uniform float u_opacity;
out vec4 o;

void main() {
  float d = length(v_p);
  float a = (1.0 - smoothstep(v_rpx - 0.5, v_rpx + 0.5, d)) * u_opacity * v_color.a;
  o = vec4(v_color.rgb * a, a);
}`;

export const UNIFORMS = ['u_ax', 'u_ay', 'u_res', 'u_dpr', 'u_offset', 'u_r', 'u_colorMode', 'u_color', 'u_palette', 'u_opacity'];
