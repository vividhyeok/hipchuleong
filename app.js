const $ = (selector) => document.querySelector(selector);

const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const fileInput = $('#fileInput');
const emptyState = $('#emptyState');
const statusText = $('#statusText');
const dropZone = $('#dropZone');
const touchHint = $('#touchHint');
const recordButton = $('#recordButton');
const snapshotButton = $('#snapshotButton');
const resetButton = $('#resetButton');
const toast = $('#toast');

const controls = {
  softness: $('#softness'),
  radius: $('#radius'),
  strength: $('#strength'),
  jiggle: $('#jiggle'),
};

const outputs = {
  softness: $('#softnessValue'),
  radius: $('#radiusValue'),
  strength: $('#strengthValue'),
  jiggle: $('#jiggleValue'),
};

const MAX_RENDER_EDGE_DESKTOP = 2048;
const MAX_RENDER_EDGE_MOBILE = 1600;
const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_DPR = 1.5;
const MOTION_EPSILON = 0.045;
const POSITION_EPSILON = 0.08;
const QUALITY_LEVELS = [0.58, 0.72, 0.86, 1];
const QUALITY_SAMPLE_FRAMES = 45;
const QUALITY_DOWN_THRESHOLD = 20;
const QUALITY_UP_THRESHOLD = 9.5;

let image = null;
let imageName = 'hipchuleong';
let mesh = null;
let resizeRaf = 0;
let animationRaf = 0;
let lastFrame = performance.now();
let activePointer = null;
let lastPointer = null;
let movedDuringPointer = false;
let recorder = null;
let recordedChunks = [];
let toastTimer = 0;
let imageLoadGeneration = 0;
let pendingDrag = null;
let frameCostTotal = 0;
let frameCostSamples = 0;
let qualityCooldown = 0;
let recordingInterval = 0;
let recordingStopTimer = 0;

const initialQualityIndex = (() => {
  const mobile = window.matchMedia('(max-width: 880px)').matches;
  const memory = navigator.deviceMemory || 0;
  const cores = navigator.hardwareConcurrency || 0;
  if ((memory && memory <= 4) || (cores && cores <= 4)) return 1;
  if (mobile) return 2;
  return QUALITY_LEVELS.length - 1;
})();

let qualityIndex = initialQualityIndex;

const state = {
  cssWidth: 0,
  cssHeight: 0,
  dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
  imageRect: { x: 0, y: 0, width: 0, height: 0 },
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function updateControlLabels() {
  for (const [key, input] of Object.entries(controls)) outputs[key].value = input.value;
}

Object.values(controls).forEach((input) => {
  input.addEventListener('input', () => {
    updateControlLabels();
    requestRenderLoop();
  });
});
updateControlLabels();

function openPicker() {
  fileInput.click();
}

['#openFile', '#openFileTop', '#openFileEmpty'].forEach((id) => {
  $(id).addEventListener('click', openPicker);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await loadImageFile(file);
  fileInput.value = '';
});

function maxRenderEdge() {
  return window.matchMedia('(max-width: 880px)').matches ? MAX_RENDER_EDGE_MOBILE : MAX_RENDER_EDGE_DESKTOP;
}

async function resizeBitmap(bitmap, width, height) {
  try {
    return await createImageBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
  } catch {
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchCtx = scratch.getContext('2d', { alpha: true });
    scratchCtx.imageSmoothingEnabled = true;
    scratchCtx.imageSmoothingQuality = 'high';
    scratchCtx.drawImage(bitmap, 0, 0, width, height);
    return createImageBitmap(scratch);
  }
}

async function createOptimizedBitmap(file) {
  const decoded = await createImageBitmap(file);
  const originalWidth = decoded.width;
  const originalHeight = decoded.height;
  const limit = maxRenderEdge();
  const scale = Math.min(1, limit / Math.max(originalWidth, originalHeight));

  if (scale >= 1) return { bitmap: decoded, originalWidth, originalHeight, optimized: false };

  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  try {
    const bitmap = await resizeBitmap(decoded, width, height);
    return { bitmap, originalWidth, originalHeight, optimized: true };
  } finally {
    decoded.close?.();
  }
}

async function fallbackImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = reject;
      next.src = url;
    });
    const originalWidth = img.naturalWidth || img.width;
    const originalHeight = img.naturalHeight || img.height;
    const limit = maxRenderEdge();
    const scale = Math.min(1, limit / Math.max(originalWidth, originalHeight));

    if (scale >= 1) return { bitmap: img, originalWidth, originalHeight, optimized: false };

    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchCtx = scratch.getContext('2d', { alpha: true });
    scratchCtx.imageSmoothingEnabled = true;
    scratchCtx.imageSmoothingQuality = 'high';
    scratchCtx.drawImage(img, 0, 0, width, height);
    return { bitmap: scratch, originalWidth, originalHeight, optimized: true };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImageFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('이미지 파일만 사용할 수 있어요.');
    return;
  }

  const generation = ++imageLoadGeneration;
  const name = file.name.replace(/\.[^.]+$/, '') || 'hipchuleong';
  statusText.textContent = `${name} · 이미지 준비 중…`;

  const acceptResult = (result) => {
    if (generation !== imageLoadGeneration) {
      result.bitmap?.close?.();
      return false;
    }
    setImage(result.bitmap, name, result);
    return true;
  };

  try {
    const result = window.createImageBitmap ? await createOptimizedBitmap(file) : await fallbackImage(file);
    acceptResult(result);
  } catch {
    if (generation !== imageLoadGeneration) return;
    try {
      const result = await fallbackImage(file);
      acceptResult(result);
    } catch {
      if (generation !== imageLoadGeneration) return;
      statusText.textContent = '이미지를 넣어 시작하세요';
      showToast('이미지를 읽지 못했어요.');
    }
  }
}

function setImage(nextImage, name = 'hipchuleong', meta = null) {
  image?.close?.();
  image = nextImage;
  imageName = name;
  emptyState.hidden = true;

  const optimizedText = meta?.optimized ? ` · ${meta.originalWidth}×${meta.originalHeight} → ${image.width}×${image.height}` : '';
  statusText.textContent = `${name}${optimizedText}`;

  fitImage();
  buildMesh();
  touchHint.hidden = false;
  touchHint.style.animation = 'none';
  void touchHint.offsetWidth;
  touchHint.style.animation = '';
  window.dispatchEvent(new CustomEvent('hipchuleong:imagechange', { detail: { loaded: true } }));
  requestRenderLoop();
  showToast(meta?.optimized ? '큰 이미지를 화면용으로 최적화했어요.' : '이미지를 불러왔어요.');
}

function fitImage() {
  if (!image) return;
  const pad = Math.max(12, Math.min(state.cssWidth, state.cssHeight) * 0.035);
  const maxW = Math.max(1, state.cssWidth - pad * 2);
  const maxH = Math.max(1, state.cssHeight - pad * 2);
  const scale = Math.min(maxW / image.width, maxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  state.imageRect = { x: (state.cssWidth - width) / 2, y: (state.cssHeight - height) / 2, width, height };
}

function buildMesh() {
  if (!image || !state.imageRect.width) {
    mesh = null;
    return;
  }

  const rect = state.imageRect;
  const targetCell = Math.max(22, Math.min(40, Math.min(rect.width, rect.height) / 16));
  const baseGrid = state.cssWidth <= 880 ? 20 : 24;
  const maxGrid = Math.max(12, Math.round(baseGrid * QUALITY_LEVELS[qualityIndex]));
  const cols = Math.max(8, Math.min(maxGrid, Math.ceil(rect.width / targetCell)));
  const rows = Math.max(8, Math.min(maxGrid, Math.ceil(rect.height / targetCell)));
  const stride = cols + 1;
  const vertices = [];

  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      const u = x / cols;
      const v = y / rows;
      const px = rect.x + u * rect.width;
      const py = rect.y + v * rect.height;
      vertices.push({ x: px, y: py, ox: px, oy: py, vx: 0, vy: 0, sx: u * image.width, sy: v * image.height });
    }
  }

  mesh = {
    cols,
    rows,
    stride,
    vertices,
    dvx: new Float32Array(vertices.length),
    dvy: new Float32Array(vertices.length),
  };
}

function captureMeshState() {
  if (!mesh || !state.imageRect.width || !state.imageRect.height) return null;
  const values = new Float32Array(mesh.vertices.length * 4);
  const width = state.imageRect.width;
  const height = state.imageRect.height;

  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    const offset = i * 4;
    values[offset] = (v.x - v.ox) / width;
    values[offset + 1] = (v.y - v.oy) / height;
    values[offset + 2] = v.vx / width;
    values[offset + 3] = v.vy / height;
  }

  return { cols: mesh.cols, rows: mesh.rows, values };
}

function sampleMeshState(snapshot, u, v, component) {
  const x = Math.max(0, Math.min(snapshot.cols, u * snapshot.cols));
  const y = Math.max(0, Math.min(snapshot.rows, v * snapshot.rows));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(snapshot.cols, x0 + 1);
  const y1 = Math.min(snapshot.rows, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const stride = snapshot.cols + 1;
  const read = (px, py) => snapshot.values[(py * stride + px) * 4 + component];
  const top = read(x0, y0) * (1 - tx) + read(x1, y0) * tx;
  const bottom = read(x0, y1) * (1 - tx) + read(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

function restoreMeshState(snapshot) {
  if (!snapshot || !mesh || !state.imageRect.width || !state.imageRect.height) return;
  const width = state.imageRect.width;
  const height = state.imageRect.height;

  for (let y = 0; y <= mesh.rows; y++) {
    for (let x = 0; x <= mesh.cols; x++) {
      const u = x / mesh.cols;
      const v = y / mesh.rows;
      const vertex = mesh.vertices[y * mesh.stride + x];
      vertex.x += sampleMeshState(snapshot, u, v, 0) * width;
      vertex.y += sampleMeshState(snapshot, u, v, 1) * height;
      vertex.vx = sampleMeshState(snapshot, u, v, 2) * width;
      vertex.vy = sampleMeshState(snapshot, u, v, 3) * height;
    }
  }
}

function rebuildMeshPreservingState() {
  const snapshot = captureMeshState();
  buildMesh();
  restoreMeshState(snapshot);
}

function resetMesh(soft = false) {
  if (!mesh) return;
  for (const v of mesh.vertices) {
    if (soft) {
      v.vx += (v.ox - v.x) * 0.08;
      v.vy += (v.oy - v.y) * 0.08;
    } else {
      v.x = v.ox;
      v.y = v.oy;
      v.vx = 0;
      v.vy = 0;
    }
  }
}

function canvasDpr(width, height) {
  const deviceDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const cssPixels = Math.max(1, width * height);
  const budgetDpr = Math.sqrt(MAX_CANVAS_PIXELS / cssPixels);
  return Math.max(0.75, Math.min(deviceDpr, budgetDpr));
}

function resizeCanvas() {
  const rect = dropZone.getBoundingClientRect();
  const nextWidth = Math.max(1, rect.width);
  const nextHeight = Math.max(1, rect.height);
  const nextDpr = canvasDpr(nextWidth, nextHeight);
  const nextPixelWidth = Math.max(1, Math.round(nextWidth * nextDpr));
  const nextPixelHeight = Math.max(1, Math.round(nextHeight * nextDpr));

  if (
    Math.abs(nextWidth - state.cssWidth) < 0.5 &&
    Math.abs(nextHeight - state.cssHeight) < 0.5 &&
    nextPixelWidth === canvas.width &&
    nextPixelHeight === canvas.height
  ) return;

  const meshSnapshot = captureMeshState();
  state.cssWidth = nextWidth;
  state.cssHeight = nextHeight;
  state.dpr = nextDpr;
  canvas.width = nextPixelWidth;
  canvas.height = nextPixelHeight;
  canvas.style.width = `${state.cssWidth}px`;
  canvas.style.height = `${state.cssHeight}px`;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  fitImage();
  buildMesh();
  restoreMeshState(meshSnapshot);
  requestRenderLoop();
}

const resizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(resizeCanvas);
});
resizeObserver.observe(dropZone);

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function insideImage(point) {
  const r = state.imageRect;
  return point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
}

function influenceRadius() {
  const minSide = Math.min(state.imageRect.width, state.imageRect.height) || 400;
  return minSide * (Number(controls.radius.value) / 100);
}

function applyDrag(point, dx, dy) {
  if (!mesh) return;
  const radius = influenceRadius();
  const strength = Number(controls.strength.value) / 100;
  for (const v of mesh.vertices) {
    const dist = Math.hypot(v.x - point.x, v.y - point.y);
    if (dist > radius) continue;
    const t = 1 - dist / radius;
    const falloff = t * t * (3 - 2 * t);
    v.vx += dx * falloff * (0.3 + strength * 0.8);
    v.vy += dy * falloff * (0.3 + strength * 0.8);
    v.x += dx * falloff * (0.16 + strength * 0.28);
    v.y += dy * falloff * (0.16 + strength * 0.28);
  }
}

function applyPulse(point) {
  if (!mesh) return;
  const radius = influenceRadius();
  const strength = Number(controls.strength.value) / 100;
  const pulse = 4 + strength * 13;
  for (const v of mesh.vertices) {
    const dx = v.x - point.x;
    const dy = v.y - point.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius || dist < 0.001) continue;
    const t = 1 - dist / radius;
    const falloff = Math.sin(t * Math.PI) * t;
    v.vx += (dx / dist) * pulse * falloff;
    v.vy += (dy / dist) * pulse * falloff;
  }
}

canvas.addEventListener('pointerdown', (event) => {
  if (!image) return;
  const point = pointerPosition(event);
  if (!insideImage(point)) return;
  activePointer = event.pointerId;
  lastPointer = point;
  pendingDrag = null;
  movedDuringPointer = false;
  canvas.setPointerCapture?.(event.pointerId);
  requestRenderLoop();
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointer || !lastPointer) return;
  const point = pointerPosition(event);
  const dx = point.x - lastPointer.x;
  const dy = point.y - lastPointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.8) movedDuringPointer = true;

  if (pendingDrag) {
    pendingDrag.point = point;
    pendingDrag.dx += dx;
    pendingDrag.dy += dy;
  } else {
    pendingDrag = { point, dx, dy };
  }

  lastPointer = point;
  requestRenderLoop();
  event.preventDefault();
});

function flushPendingDrag() {
  if (!pendingDrag) return;
  const drag = pendingDrag;
  pendingDrag = null;
  applyDrag(drag.point, drag.dx, drag.dy);
}

function endPointer(event) {
  if (event.pointerId !== activePointer) return;
  flushPendingDrag();
  if (!movedDuringPointer && lastPointer) applyPulse(lastPointer);
  activePointer = null;
  lastPointer = null;
  requestRenderLoop();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', () => {
  flushPendingDrag();
  activePointer = null;
  lastPointer = null;
});

function physicsStep(dt) {
  if (!mesh) return;
  const { cols, rows, stride, vertices, dvx, dvy } = mesh;
  const softness = Number(controls.softness.value) / 100;
  const jiggle = Number(controls.jiggle.value) / 100;
  const spring = 0.045 + (1 - softness) * 0.13;
  const neighborSpring = 0.012 + (1 - softness) * 0.035;
  const damping = 0.72 + jiggle * 0.24;
  const scale = Math.min(2, dt / 16.667);

  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      const i = y * stride + x;
      const v = vertices[i];
      let fx = (v.ox - v.x) * spring;
      let fy = (v.oy - v.y) * spring;
      let count = 0;
      let avgDx = 0;
      let avgDy = 0;
      if (x > 0) {
        const n = vertices[i - 1];
        avgDx += (n.x - n.ox) - (v.x - v.ox);
        avgDy += (n.y - n.oy) - (v.y - v.oy);
        count++;
      }
      if (x < cols) {
        const n = vertices[i + 1];
        avgDx += (n.x - n.ox) - (v.x - v.ox);
        avgDy += (n.y - n.oy) - (v.y - v.oy);
        count++;
      }
      if (y > 0) {
        const n = vertices[i - stride];
        avgDx += (n.x - n.ox) - (v.x - v.ox);
        avgDy += (n.y - n.oy) - (v.y - v.oy);
        count++;
      }
      if (y < rows) {
        const n = vertices[i + stride];
        avgDx += (n.x - n.ox) - (v.x - v.ox);
        avgDy += (n.y - n.oy) - (v.y - v.oy);
        count++;
      }
      if (count) {
        fx += (avgDx / count) * neighborSpring;
        fy += (avgDy / count) * neighborSpring;
      }
      dvx[i] = fx * scale;
      dvy[i] = fy * scale;
    }
  }

  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    v.vx = (v.vx + dvx[i]) * Math.pow(damping, scale);
    v.vy = (v.vy + dvy[i]) * Math.pow(damping, scale);
    v.x += v.vx * scale;
    v.y += v.vy * scale;
  }
}

function drawTriangle(img, sx0, sy0, sx1, sy1, sx2, sy2, dx0, dy0, dx1, dy1, dx2, dy2) {
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 1e-6) return;
  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const e = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / denom;
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const f = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / denom;
  const overlap = Math.max(0.55, 1.1 / state.dpr);
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const l0 = Math.hypot(dx0 - cx, dy0 - cy) || 1;
  const l1 = Math.hypot(dx1 - cx, dy1 - cy) || 1;
  const l2 = Math.hypot(dx2 - cx, dy2 - cy) || 1;
  const c0x = dx0 + ((dx0 - cx) / l0) * overlap;
  const c0y = dy0 + ((dy0 - cy) / l0) * overlap;
  const c1x = dx1 + ((dx1 - cx) / l1) * overlap;
  const c1y = dy1 + ((dy1 - cy) / l1) * overlap;
  const c2x = dx2 + ((dx2 - cx) / l2) * overlap;
  const c2y = dy2 + ((dy2 - cy) / l2) * overlap;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(c0x, c0y);
  ctx.lineTo(c1x, c1y);
  ctx.lineTo(c2x, c2y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);

  const sourcePad = 2;
  const sourceX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2) - sourcePad));
  const sourceY = Math.max(0, Math.floor(Math.min(sy0, sy1, sy2) - sourcePad));
  const sourceRight = Math.min(img.width, Math.ceil(Math.max(sx0, sx1, sx2) + sourcePad));
  const sourceBottom = Math.min(img.height, Math.ceil(Math.max(sy0, sy1, sy2) + sourcePad));
  const sourceWidth = Math.max(1, sourceRight - sourceX);
  const sourceHeight = Math.max(1, sourceBottom - sourceY);
  ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, sourceX, sourceY, sourceWidth, sourceHeight);
  ctx.restore();
}

function render() {
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.fillStyle = '#111113';
  ctx.fillRect(0, 0, state.cssWidth, state.cssHeight);
  if (!image || !mesh) return;
  const { cols, rows, stride, vertices } = mesh;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * stride + x;
      const v00 = vertices[i];
      const v10 = vertices[i + 1];
      const v01 = vertices[i + stride];
      const v11 = vertices[i + stride + 1];
      drawTriangle(image, v00.sx, v00.sy, v10.sx, v10.sy, v11.sx, v11.sy, v00.x, v00.y, v10.x, v10.y, v11.x, v11.y);
      drawTriangle(image, v00.sx, v00.sy, v11.sx, v11.sy, v01.sx, v01.sy, v00.x, v00.y, v11.x, v11.y, v01.x, v01.y);
    }
  }
}

function hasMotion() {
  if (!mesh) return false;
  for (const v of mesh.vertices) {
    if (Math.abs(v.vx) > MOTION_EPSILON || Math.abs(v.vy) > MOTION_EPSILON || Math.abs(v.x - v.ox) > POSITION_EPSILON || Math.abs(v.y - v.oy) > POSITION_EPSILON) return true;
  }
  return false;
}

function shouldContinueAnimating() {
  return pendingDrag !== null || activePointer !== null || recorder?.state === 'recording' || hasMotion();
}

function monitorFrameCost(frameCost) {
  frameCostTotal += frameCost;
  frameCostSamples += 1;

  if (qualityCooldown > 0) {
    qualityCooldown -= 1;
    if (frameCostSamples >= QUALITY_SAMPLE_FRAMES) {
      frameCostTotal = 0;
      frameCostSamples = 0;
    }
    return;
  }

  if (frameCostSamples < QUALITY_SAMPLE_FRAMES) return;
  const average = frameCostTotal / frameCostSamples;
  frameCostTotal = 0;
  frameCostSamples = 0;

  let nextQuality = qualityIndex;
  if (average > QUALITY_DOWN_THRESHOLD && qualityIndex > 0) {
    nextQuality -= 1;
  } else if (
    average < QUALITY_UP_THRESHOLD &&
    qualityIndex < QUALITY_LEVELS.length - 1 &&
    activePointer === null &&
    recorder?.state !== 'recording'
  ) {
    nextQuality += 1;
  }

  if (nextQuality !== qualityIndex) {
    const snapshot = captureMeshState();
    qualityIndex = nextQuality;
    buildMesh();
    restoreMeshState(snapshot);
    qualityCooldown = 120;
  }
}

function frame(now) {
  animationRaf = 0;
  const dt = Math.min(32, now - lastFrame || 16.667);
  lastFrame = now;
  const frameStart = performance.now();
  flushPendingDrag();
  physicsStep(dt);
  render();
  monitorFrameCost(performance.now() - frameStart);
  if (shouldContinueAnimating()) requestRenderLoop();
}

function requestRenderLoop() {
  if (animationRaf || document.hidden) return;
  lastFrame = performance.now();
  animationRaf = requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(animationRaf);
    animationRaf = 0;
  } else if (image) requestRenderLoop();
});

resetButton.addEventListener('click', () => {
  resetMesh(false);
  requestRenderLoop();
  showToast('원래 모양으로 돌아왔어요.');
});

snapshotButton.addEventListener('click', () => {
  if (!image) return showToast('먼저 이미지를 넣어주세요.');
  render();
  canvas.toBlob((blob) => {
    if (!blob) return showToast('PNG 저장에 실패했어요.');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${imageName}-hipchuleong.png`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('PNG를 저장했어요.');
  }, 'image/png');
});

function preferredRecorderMime() {
  if (!window.MediaRecorder) return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

function resetRecordingUi() {
  clearInterval(recordingInterval);
  clearTimeout(recordingStopTimer);
  recordingInterval = 0;
  recordingStopTimer = 0;
  recordButton.disabled = false;
  recordButton.textContent = '5초 녹화';
}

recordButton.addEventListener('click', () => {
  if (!image) return showToast('먼저 이미지를 넣어주세요.');
  if (!canvas.captureStream || !window.MediaRecorder) return showToast('이 브라우저는 녹화를 지원하지 않아요.');
  if (recorder?.state === 'recording') return;

  const mimeType = preferredRecorderMime();
  const stream = canvas.captureStream(30);
  recordedChunks = [];
  let failed = false;

  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    return showToast('녹화를 시작하지 못했어요.');
  }

  const activeRecorder = recorder;
  activeRecorder.ondataavailable = (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  };
  activeRecorder.onerror = () => {
    failed = true;
    stream.getTracks().forEach((track) => track.stop());
    if (recorder === activeRecorder) recorder = null;
    resetRecordingUi();
    showToast('녹화 중 오류가 발생했어요.');
  };
  activeRecorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (recorder === activeRecorder) recorder = null;
    resetRecordingUi();
    if (failed) return;

    const type = activeRecorder.mimeType || mimeType || 'video/webm';
    const blob = new Blob(recordedChunks, { type });
    if (!blob.size) return showToast('녹화 파일을 만들지 못했어요.');
    const extension = type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${imageName}-hipchuleong.${extension}`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('녹화 파일을 저장했어요.');
  };

  try {
    activeRecorder.start(250);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    recorder = null;
    resetRecordingUi();
    return showToast('녹화를 시작하지 못했어요.');
  }

  recordButton.disabled = true;
  requestRenderLoop();
  let left = 5;
  recordButton.textContent = `${left}초…`;
  recordingInterval = window.setInterval(() => {
    left -= 1;
    recordButton.textContent = `${Math.max(0, left)}초…`;
  }, 1000);
  recordingStopTimer = window.setTimeout(() => {
    if (activeRecorder.state === 'recording') activeRecorder.stop();
  }, 5000);
});

window.addEventListener('paste', async (event) => {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type.startsWith('image/'));
  const file = imageItem?.getAsFile();
  if (file) {
    event.preventDefault();
    await loadImageFile(file);
  }
});

['dragenter', 'dragover'].forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
});
dropZone.addEventListener('drop', async (event) => {
  const file = [...(event.dataTransfer?.files || [])].find((entry) => entry.type.startsWith('image/'));
  if (file) await loadImageFile(file);
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
