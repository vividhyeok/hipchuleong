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

let image = null;
let imageName = 'hipchuleong';
let mesh = null;
let resizeRaf = 0;
let lastFrame = performance.now();
let activePointer = null;
let lastPointer = null;
let movedDuringPointer = false;
let recorder = null;
let recordedChunks = [];
let toastTimer = 0;

const state = {
  cssWidth: 0,
  cssHeight: 0,
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  imageRect: { x: 0, y: 0, width: 0, height: 0 },
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function updateControlLabels() {
  for (const [key, input] of Object.entries(controls)) {
    outputs[key].value = input.value;
  }
}

Object.values(controls).forEach((input) => input.addEventListener('input', updateControlLabels));
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

async function loadImageFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('이미지 파일만 사용할 수 있어요.');
    return;
  }

  try {
    const bitmap = await createImageBitmap(file);
    setImage(bitmap, file.name.replace(/\.[^.]+$/, '') || 'hipchuleong');
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImage(img, file.name.replace(/\.[^.]+$/, '') || 'hipchuleong');
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showToast('이미지를 읽지 못했어요.');
    };
    img.src = url;
  }
}

function setImage(nextImage, name = 'hipchuleong') {
  image?.close?.();
  image = nextImage;
  imageName = name;
  emptyState.hidden = true;
  statusText.textContent = `${name} · 눌러서 출렁이기`;
  fitImage();
  buildMesh();
  touchHint.hidden = false;
  touchHint.style.animation = 'none';
  void touchHint.offsetWidth;
  touchHint.style.animation = '';
  showToast('이미지를 불러왔어요.');
}

function fitImage() {
  if (!image) return;
  const pad = Math.max(12, Math.min(state.cssWidth, state.cssHeight) * 0.035);
  const maxW = Math.max(1, state.cssWidth - pad * 2);
  const maxH = Math.max(1, state.cssHeight - pad * 2);
  const scale = Math.min(maxW / image.width, maxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  state.imageRect = {
    x: (state.cssWidth - width) / 2,
    y: (state.cssHeight - height) / 2,
    width,
    height,
  };
}

function buildMesh() {
  if (!image || !state.imageRect.width) {
    mesh = null;
    return;
  }

  const rect = state.imageRect;
  const targetCell = Math.max(18, Math.min(34, Math.min(rect.width, rect.height) / 18));
  const cols = Math.max(8, Math.min(34, Math.ceil(rect.width / targetCell)));
  const rows = Math.max(8, Math.min(34, Math.ceil(rect.height / targetCell)));
  const vertices = [];

  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      const u = x / cols;
      const v = y / rows;
      const px = rect.x + u * rect.width;
      const py = rect.y + v * rect.height;
      vertices.push({ x: px, y: py, ox: px, oy: py, vx: 0, vy: 0, u, v });
    }
  }

  mesh = { cols, rows, vertices };
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

function resizeCanvas() {
  const rect = dropZone.getBoundingClientRect();
  const newDpr = Math.min(window.devicePixelRatio || 1, 2);
  state.cssWidth = Math.max(1, rect.width);
  state.cssHeight = Math.max(1, rect.height);
  state.dpr = newDpr;
  canvas.width = Math.round(state.cssWidth * newDpr);
  canvas.height = Math.round(state.cssHeight * newDpr);
  canvas.style.width = `${state.cssWidth}px`;
  canvas.style.height = `${state.cssHeight}px`;
  ctx.setTransform(newDpr, 0, 0, newDpr, 0, 0);
  fitImage();
  buildMesh();
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
    const nx = dx / dist;
    const ny = dy / dist;
    v.vx += nx * pulse * falloff;
    v.vy += ny * pulse * falloff;
  }
}

canvas.addEventListener('pointerdown', (event) => {
  if (!image) return;
  const point = pointerPosition(event);
  if (!insideImage(point)) return;
  activePointer = event.pointerId;
  lastPointer = point;
  movedDuringPointer = false;
  canvas.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointer || !lastPointer) return;
  const point = pointerPosition(event);
  const dx = point.x - lastPointer.x;
  const dy = point.y - lastPointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.8) movedDuringPointer = true;
  applyDrag(point, dx, dy);
  lastPointer = point;
  event.preventDefault();
});

function endPointer(event) {
  if (event.pointerId !== activePointer) return;
  if (!movedDuringPointer && lastPointer) applyPulse(lastPointer);
  activePointer = null;
  lastPointer = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', () => {
  activePointer = null;
  lastPointer = null;
});

function physicsStep(dt) {
  if (!mesh) return;
  const { cols, rows, vertices } = mesh;
  const softness = Number(controls.softness.value) / 100;
  const jiggle = Number(controls.jiggle.value) / 100;
  const spring = 0.045 + (1 - softness) * 0.13;
  const neighborSpring = 0.012 + (1 - softness) * 0.035;
  const damping = 0.72 + jiggle * 0.24;
  const scale = Math.min(2, dt / 16.667);
  const dvx = new Float32Array(vertices.length);
  const dvy = new Float32Array(vertices.length);

  const idx = (x, y) => y * (cols + 1) + x;

  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      const i = idx(x, y);
      const v = vertices[i];
      let fx = (v.ox - v.x) * spring;
      let fy = (v.oy - v.y) * spring;
      let count = 0;
      let avgDx = 0;
      let avgDy = 0;

      if (x > 0) { const n = vertices[idx(x - 1, y)]; avgDx += (n.x - n.ox) - (v.x - v.ox); avgDy += (n.y - n.oy) - (v.y - v.oy); count++; }
      if (x < cols) { const n = vertices[idx(x + 1, y)]; avgDx += (n.x - n.ox) - (v.x - v.ox); avgDy += (n.y - n.oy) - (v.y - v.oy); count++; }
      if (y > 0) { const n = vertices[idx(x, y - 1)]; avgDx += (n.x - n.ox) - (v.x - v.ox); avgDy += (n.y - n.oy) - (v.y - v.oy); count++; }
      if (y < rows) { const n = vertices[idx(x, y + 1)]; avgDx += (n.x - n.ox) - (v.x - v.ox); avgDy += (n.y - n.oy) - (v.y - v.oy); count++; }

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

function expandTriangle(p0, p1, p2, amount) {
  const cx = (p0.x + p1.x + p2.x) / 3;
  const cy = (p0.y + p1.y + p2.y) / 3;
  return [p0, p1, p2].map((point) => {
    const dx = point.x - cx;
    const dy = point.y - cy;
    const length = Math.hypot(dx, dy) || 1;
    return {
      x: point.x + (dx / length) * amount,
      y: point.y + (dy / length) * amount,
    };
  });
}

function drawTriangle(img, s0, s1, s2, d0, d1, d2) {
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 1e-6) return;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;
  const overlap = Math.max(0.55, 1.1 / state.dpr);
  const [c0, c1, c2] = expandTriangle(d0, d1, d2, overlap);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(c0.x, c0.y);
  ctx.lineTo(c1.x, c1.y);
  ctx.lineTo(c2.x, c2.y);
  ctx.closePath();
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function render() {
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.fillStyle = '#111113';
  ctx.fillRect(0, 0, state.cssWidth, state.cssHeight);

  if (!image || !mesh) return;
  const { cols, rows, vertices } = mesh;
  const idx = (x, y) => y * (cols + 1) + x;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v00 = vertices[idx(x, y)];
      const v10 = vertices[idx(x + 1, y)];
      const v01 = vertices[idx(x, y + 1)];
      const v11 = vertices[idx(x + 1, y + 1)];

      const s00 = { x: v00.u * image.width, y: v00.v * image.height };
      const s10 = { x: v10.u * image.width, y: v10.v * image.height };
      const s01 = { x: v01.u * image.width, y: v01.v * image.height };
      const s11 = { x: v11.u * image.width, y: v11.v * image.height };

      drawTriangle(image, s00, s10, s11, v00, v10, v11);
      drawTriangle(image, s00, s11, s01, v00, v11, v01);
    }
  }
}

function frame(now) {
  const dt = Math.min(32, now - lastFrame || 16.667);
  lastFrame = now;
  physicsStep(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

resetButton.addEventListener('click', () => {
  resetMesh(false);
  showToast('원래 모양으로 돌아왔어요.');
});

snapshotButton.addEventListener('click', () => {
  if (!image) return showToast('먼저 이미지를 넣어주세요.');
  render();
  const link = document.createElement('a');
  link.download = `${imageName}-hipchuleong.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast('PNG를 저장했어요.');
});

function preferredRecorderMime() {
  if (!window.MediaRecorder) return '';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

recordButton.addEventListener('click', () => {
  if (!image) return showToast('먼저 이미지를 넣어주세요.');
  if (!canvas.captureStream || !window.MediaRecorder) return showToast('이 브라우저는 녹화를 지원하지 않아요.');
  if (recorder?.state === 'recording') return;

  const mimeType = preferredRecorderMime();
  const stream = canvas.captureStream(60);
  recordedChunks = [];

  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    return showToast('녹화를 시작하지 못했어요.');
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: recorder.mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${imageName}-hipchuleong.webm`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    recordButton.disabled = false;
    recordButton.textContent = '5초 녹화';
    showToast('녹화 파일을 저장했어요.');
  };

  recorder.start();
  recordButton.disabled = true;
  let left = 5;
  recordButton.textContent = `${left}초…`;
  const timer = setInterval(() => {
    left -= 1;
    recordButton.textContent = `${Math.max(0, left)}초…`;
  }, 1000);
  setTimeout(() => {
    clearInterval(timer);
    if (recorder?.state === 'recording') recorder.stop();
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
