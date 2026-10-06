import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pagePath = new URL('../docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html', import.meta.url);
const html = readFileSync(fileURLToPath(pagePath), 'utf8');
const checks = [];

function check(name, run) {
  try {
    run();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, message: error.message });
  }
}

function expectMatch(expression, message) {
  assert.match(html, expression, message);
}

check('reference sample map and landmarks stay image-locked', () => {
  const match = html.match(/const FIELD_GRID\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  assert.ok(match, 'FIELD_GRID must remain an inline literal');
  const grid = JSON.parse(match[1]
    .replace(/'([^']*)'/g, '"$1"')
    .replace(/,\s*([\]}])/g, '$1'));
  assert.equal(grid.length, 8);
  assert.ok(grid.every((row) => row.length === 13));
  assert.equal(
    createHash('sha256').update(grid.flat().join('|')).digest('hex'),
    '0a1e9410fa474019b0fa97ed2c0571f976c211a1c3b655b2ce8847a784aa3b71',
    'all 104 sampled colors and their positions must remain locked to the supplied reference',
  );
  assert.equal(grid[0][0], '#0f3a3c');
  assert.equal(grid[0][6], '#a371d4');
  assert.equal(grid[4][6], '#475ca0');
  assert.equal(grid[7][0], '#af73d8');
  assert.equal(grid[7][12], '#0f3c39');
  expectMatch(/const FIELD_Y\s*=\s*\[0, 40 \/ 333, 80 \/ 333, 120 \/ 333, 240 \/ 333, 280 \/ 333, 320 \/ 333, 1\]/,
    'the reference field has intentionally nonuniform vertical sample positions');
});

check('the artwork is exposed once and its canvases are decorative', () => {
  expectMatch(/<main[^>]*class="field-stage"[^>]*role="img"[^>]*aria-label="[^"]+"/,
    'the stage should expose one descriptive accessible name');
  expectMatch(/<canvas[^>]*id="color-field"[^>]*aria-hidden="true"/,
    'the animated canvas should not be separately announced');
  expectMatch(/<canvas[^>]*id="color-field-fallback"[^>]*aria-hidden="true"/,
    'the fallback canvas should not be separately announced');
});

check('the page uses a self-contained WebGL2 image-field shader', () => {
  expectMatch(/getContext\(\s*['"]webgl2['"]/,
    'the primary renderer should request WebGL2');
  expectMatch(/#version 300 es/,
    'the inline fragment shader should use GLSL ES 3.00');
  expectMatch(/texImage2D\([\s\S]{0,220}RGBA8/,
    'the sampled color field should be uploaded as aligned RGBA8 texels');
  expectMatch(/FIELD_Y[\s\S]{0,500}uniform1fv|uniform1fv[\s\S]{0,500}FIELD_Y/,
    'the shader should retain the uneven vertical row mapping');
  expectMatch(/gl\.drawArrays\(/, 'WebGL2 should render the full-screen field');
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i,
    'the page should not depend on remote runtime assets');
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]+\b(?:src|href)\s*=/i,
    'all scripts/stylesheets must be inline rather than fetched as runtime assets');
  assert.doesNotMatch(html, /\burl\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/i,
    'the page must not request runtime assets or open network connections');
});

check('the nebula uses seeded multi-scale noise, local flow, and no traveling wipe', () => {
  expectMatch(/float\s+gradientNoise\s*\(/, 'the shader should define smooth gradient noise');
  expectMatch(/float\s+fbm\s*\(/, 'the shader should layer fractal noise');
  expectMatch(/for\s*\(\s*int\s+octave\s*=\s*0;\s*octave\s*<\s*3;/,
    'fractal detail should use a bounded three-octave loop for per-frame cost');
  expectMatch(/vec2\s+curlFlow\s*\(/, 'the shader should have a spatially varying curl field');
  expectMatch(/vec2\s+vortexFlow\s*\(/, 'the shader should form local, moving eddies around distinct centers');
  expectMatch(/domainWarp|warpedDomain|warpField/i,
    'the shader should domain-warp its noise to form irregular nebula structures');
  expectMatch(/float\s+(?:filament|ridged|wisp)[A-Za-z0-9_]*\s*=/i,
    'the shader should shape high-frequency noise into fine wisps');
  expectMatch(/float\s+starDust\s*\(/, 'the shader should add restrained palette-tinted dust points');
  expectMatch(/const MOTION_SEED\s*=\s*Math\.floor\(Math\.random\(\)/,
    'each load should use a fresh, deterministic shader seed');
  const fragmentShader = html.match(/const\s+fragmentSource\s*=\s*`([\s\S]*?)`;/);
  assert.ok(fragmentShader, 'fragment shader should remain inline');
  const shaderMain = fragmentShader[1].match(/void\s+main\s*\(\s*\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(shaderMain, 'fragment shader should have a main body');
  assert.equal([...shaderMain[1].matchAll(/\bfbm\s*\(/g)].length, 3,
    'keep the intended three full fractal passes per fragment');
  assert.equal([...shaderMain[1].matchAll(/\bcurlFlow\s*\(/g)].length, 2,
    'use two flow scales rather than repeatedly evaluating flow per fragment');
  assert.equal([...shaderMain[1].matchAll(/\bvortexFlow\s*\(/g)].length, 1,
    'evaluate local vortices once per fragment');
  assert.doesNotMatch(html, /travelStateAtTime|u_frontX|u_direction|CYCLE_DURATION|sampleUv\.x\s*-=/,
    'the whole composition must not be pushed through a periodic left-right front');
});

check('blue grading is restricted to teal side regions', () => {
  expectMatch(/tealEdgeBlueBias|gradeTealEdges/i,
    'the slight blue shift should be an explicit teal-edge grading step');
  expectMatch(/edgeMask|sideMask|tealMask/i,
    'the blue shift should be spatially and chromatically masked');
});

check('motion, visibility, sizing, and WebGL fallback lifecycle are handled', () => {
  expectMatch(/prefers-reduced-motion:\s*reduce/, 'reduced motion should be honored');
  expectMatch(/visibilitychange/, 'the logical motion clock should pause while hidden');
  expectMatch(/addEventListener\(['"]resize['"]/, 'the stage should resize with its viewport');
  expectMatch(/webglcontextlost[\s\S]{0,220}preventDefault\(/,
    'a lost WebGL context should be recoverable and switch to fallback');
  expectMatch(/webglcontextrestored[\s\S]{0,1000}(?:initialize|create|setup)(?:WebGL|Gpu|GL)/i,
    'restoring the context should recreate its GPU resources');
  expectMatch(/color-field-fallback[\s\S]{0,1000}getContext\(['"]2d['"]|getContext\(['"]2d['"]\)[\s\S]{0,1000}color-field-fallback/,
    'the fallback should draw a static image-derived frame with Canvas2D');
  const pixelCap = html.match(/const MAX_FRAMEBUFFER_PIXELS\s*=\s*(\d+)/);
  assert.ok(pixelCap, 'GPU allocation should have a fixed framebuffer pixel cap');
  assert.equal(Number(pixelCap[1]), 524288,
    'keep the tested framebuffer budget so the shader cost stays bounded');
  expectMatch(/Math\.floor\(cssWidth \* scale\)[\s\S]{0,100}Math\.floor\(cssHeight \* scale\)/,
    'pixel dimensions should round down so fractional sizing cannot exceed the cap');
});

check('the output remains a clean, text-free full-page artwork', () => {
  assert.doesNotMatch(html, /<(?:h[1-6]|p|button|input|select|textarea)\b/i,
    'the page should not add visible copy or controls');
  assert.doesNotMatch(html, /radial-gradient\(/i,
    'the field should be derived from the supplied sample map, not added radial blobs');
});

for (const result of checks) {
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.message ? `: ${result.message}` : ''}\n`);
}

if (checks.some((result) => !result.passed)) {
  process.exitCode = 1;
} else {
  process.stdout.write(`\n${checks.length}/${checks.length} checks passed.\n`);
}
