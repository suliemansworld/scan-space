import * as THREE from 'three';

// ── State ──────────────────────────────────────────────
const dims = { length: 48, width: 36, height: 30 }; // inches
const defaults = { ...dims };

let refOrientation = null; // { alpha, beta, gamma }
let stream = null;
let animId = null;

// ── Three.js globals ───────────────────────────────────
let scene, camera, renderer;
let wireframe, faceMesh;
const spheres = [];

// Drag state
let activeDrag = null; // { axis, track, thumb, startX, startVal }

// ── DOM refs ───────────────────────────────────────────
const camEl = document.getElementById('cam');
const canvasEl = document.getElementById('scene');
const startOverlay = document.getElementById('start-overlay');
const startBtn = document.getElementById('start-btn');
const controlsEl = document.getElementById('controls');
const volumeVal = document.getElementById('volume-val');
const hintEl = document.getElementById('hint');

const dragRows = document.querySelectorAll('.drag-row');
const axisValEls = {};
dragRows.forEach(r => { axisValEls[r.dataset.axis] = r.querySelector('.axis-val'); });

// ── Camera ─────────────────────────────────────────────
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    camEl.srcObject = stream;
    await camEl.play();
    return true;
  } catch (e) {
    console.error('Camera error:', e);
    alert('Camera access is required. Please allow camera in Settings > Safari > Camera.');
    return false;
  }
}

// ── Orientation ────────────────────────────────────────
async function requestMotionPermission() {
  // iOS 13+ requires requestPermission inside a user gesture
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      return perm === 'granted';
    } catch (e) {
      console.error('Motion permission denied:', e);
      return false;
    }
  }
  // Android or older iOS — permission not required
  return true;
}

function startOrientationTracking() {
  window.addEventListener('deviceorientation', onOrientation, true);
}

function onOrientation(e) {
  if (!refOrientation) return;
  if (e.alpha === null) return;
  updateCamera(e.alpha, e.beta, e.gamma);
}

function setAnchor() {
  // anchor orientation will be set from the first orientation event after tracking starts
  window.addEventListener('deviceorientation', function anchorOnce(e) {
    if (e.alpha === null) return;
    refOrientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    window.removeEventListener('deviceorientation', anchorOnce, true);
  }, true);
}

function updateCamera(alpha, beta, gamma) {
  const dAlpha = (alpha - refOrientation.alpha) * (Math.PI / 180);
  const dBeta = (beta - refOrientation.beta) * (Math.PI / 180);
  const dGamma = (gamma - refOrientation.gamma) * (Math.PI / 180);

  const radius = 2.5;
  const horizAngle = dGamma;
  const vertAngle = Math.PI / 2 + dBeta * 0.7;

  camera.position.set(
    radius * Math.sin(vertAngle) * Math.sin(horizAngle),
    radius * Math.cos(vertAngle),
    radius * Math.sin(vertAngle) * Math.cos(horizAngle)
  );
  camera.lookAt(0, 0, 0);
}

// ── Three.js Setup ─────────────────────────────────────
function initScene() {
  scene = new THREE.Scene();

  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / (h || 1);
  camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 20);
  camera.position.set(0, 0.3, 2.5);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  sizeRenderer();

  // Ambient light
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  buildBox();
}

function sizeRenderer() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / (h || 1);
  camera.updateProjectionMatrix();
}

function buildBox() {
  // Clear old
  if (wireframe) { scene.remove(wireframe); wireframe.geometry.dispose(); }
  if (faceMesh) { scene.remove(faceMesh); faceMesh.geometry.dispose(); }
  spheres.forEach(s => { scene.remove(s); s.geometry.dispose(); });

  const w = dims.width / 39.3701;
  const h = dims.height / 39.3701;
  const d = dims.length / 39.3701;

  const geo = new THREE.BoxGeometry(w, h, d);

  // Wireframe
  const edges = new THREE.EdgesGeometry(geo);
  wireframe = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.9 }));
  scene.add(wireframe);

  // Transparent faces for raycasting + visual fill
  const mat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide });
  faceMesh = new THREE.Mesh(geo, mat);
  scene.add(faceMesh);

  // Corner spheres
  const sGeo = new THREE.SphereGeometry(0.025, 8, 8);
  const sMat = new THREE.MeshBasicMaterial({ color: 0x88bbff });
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const corners = [
    [-hw, -hh,  hd], [ hw, -hh,  hd], [ hw, -hh, -hd], [-hw, -hh, -hd], // floor
    [-hw,  hh,  hd], [ hw,  hh,  hd], [ hw,  hh, -hd], [-hw,  hh, -hd], // upper
  ];
  corners.forEach(([cx, cy, cz]) => {
    const s = new THREE.Mesh(sGeo, sMat);
    s.position.set(cx, cy, cz);
    scene.add(s);
    spheres.push(s);
  });
}

// ── Volume ─────────────────────────────────────────────
function updateVolume() {
  const ft3 = (dims.length * dims.width * dims.height) / 1728;
  volumeVal.textContent = ft3.toFixed(1);
}

// ── Box face nudging via raycasting ────────────────────
function nudgeFace(clientX, clientY, shrink) {
  const rect = canvasEl.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);

  const hits = raycaster.intersectObject(faceMesh, false);
  if (hits.length === 0) return;

  const normal = hits[0].face.normal.clone();
  // Transform normal to world space
  normal.transformDirection(faceMesh.matrixWorld);

  const delta = shrink ? -1 : 1;
  const threshold = 0.5;

  if (Math.abs(normal.x) > threshold) {
    dims.width = Math.max(6, dims.width + delta * Math.sign(normal.x));
  }
  if (Math.abs(normal.y) > threshold) {
    dims.height = Math.max(6, dims.height + delta * Math.sign(normal.y));
  }
  if (Math.abs(normal.z) > threshold) {
    dims.length = Math.max(6, dims.length + delta * Math.sign(normal.z));
  }

  reflectDims();
}

// ── Reflect dimensions to UI & 3D ──────────────────────
function reflectDims() {
  dims.length = Math.round(dims.length * 2) / 2;
  dims.width = Math.round(dims.width * 2) / 2;
  dims.height = Math.round(dims.height * 2) / 2;

  axisValEls.length.textContent = Math.round(dims.length);
  axisValEls.width.textContent = Math.round(dims.width);
  axisValEls.height.textContent = Math.round(dims.height);

  buildBox();
  updateVolume();
}

// ── Drag handle logic ──────────────────────────────────
function getDragTrackAndThumb(row) {
  return {
    track: row.querySelector('.drag-track'),
    thumb: row.querySelector('.drag-thumb'),
    fillL: row.querySelector('.drag-fill-left'),
    fillR: row.querySelector('.drag-fill-right'),
  };
}

function onDragStart(e) {
  const row = e.target.closest('.drag-row');
  if (!row) return;
  const axis = row.dataset.axis;
  const { track, thumb, fillL, fillR } = getDragTrackAndThumb(row);

  const touch = e.touches[0];
  activeDrag = {
    axis,
    track,
    thumb,
    fillL,
    fillR,
    startX: touch.clientX,
    startVal: dims[axis],
  };
  thumb.style.transition = 'none';
  e.preventDefault();
}

function onDragMove(e) {
  if (!activeDrag) return;
  const touch = e.touches[0];
  const dx = touch.clientX - activeDrag.startX;
  // 1px = 0.5 inches
  let newVal = activeDrag.startVal + dx * 0.5;
  newVal = Math.max(6, Math.min(144, newVal));
  dims[activeDrag.axis] = newVal;

  // Update thumb position visually
  const pct = ((newVal - 6) / (144 - 6)) * 100;
  activeDrag.thumb.style.left = pct + '%';
  activeDrag.fillL.style.right = (100 - pct) + '%';
  activeDrag.fillR.style.left = pct + '%';

  axisValEls[activeDrag.axis].textContent = Math.round(newVal);
  updateVolume();
  e.preventDefault();
}

function onDragEnd(e) {
  if (!activeDrag) return;
  activeDrag.thumb.style.transition = 'transform 0.05s ease-out';
  // Snap to 0.5"
  dims[activeDrag.axis] = Math.round(dims[activeDrag.axis] * 2) / 2;
  const pct = ((dims[activeDrag.axis] - 6) / (144 - 6)) * 100;
  activeDrag.thumb.style.left = pct + '%';
  activeDrag.fillL.style.right = (100 - pct) + '%';
  activeDrag.fillR.style.left = pct + '%';
  axisValEls[activeDrag.axis].textContent = Math.round(dims[activeDrag.axis]);

  buildBox();
  updateVolume();
  activeDrag = null;
}

// Attach drag handlers
document.getElementById('controls').addEventListener('touchstart', onDragStart, { passive: false });
document.addEventListener('touchmove', onDragMove, { passive: false });
document.addEventListener('touchend', onDragEnd);
document.addEventListener('touchcancel', onDragEnd);

// ── Box face tap / long-press ──────────────────────────
let faceTouchTimer = null;
let faceTouchPos = null;

canvasEl.addEventListener('touchstart', (e) => {
  // Only handle single-finger touches directly on the canvas
  if (e.touches.length !== 1) return;
  // Don't handle if we're dragging a handle
  if (activeDrag) return;

  faceTouchPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  faceTouchTimer = setTimeout(() => {
    // Long press = shrink
    nudgeFace(faceTouchPos.x, faceTouchPos.y, true);
    faceTouchTimer = null;
    faceTouchPos = null;
  }, 400);
  e.preventDefault();
});

canvasEl.addEventListener('touchmove', (e) => {
  // Cancel long-press if finger moves too much
  if (faceTouchTimer && faceTouchPos) {
    const dx = e.touches[0].clientX - faceTouchPos.x;
    const dy = e.touches[0].clientY - faceTouchPos.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(faceTouchTimer);
      faceTouchTimer = null;
      faceTouchPos = null;
    }
  }
});

canvasEl.addEventListener('touchend', (e) => {
  if (faceTouchTimer) {
    // Short tap = expand
    clearTimeout(faceTouchTimer);
    faceTouchTimer = null;
    if (faceTouchPos) {
      nudgeFace(faceTouchPos.x, faceTouchPos.y, false);
    }
    faceTouchPos = null;
  }
});

canvasEl.addEventListener('touchcancel', () => {
  if (faceTouchTimer) {
    clearTimeout(faceTouchTimer);
    faceTouchTimer = null;
    faceTouchPos = null;
  }
});

// ── Animation loop ─────────────────────────────────────
function animate() {
  animId = requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

// ── Resize handler ─────────────────────────────────────
window.addEventListener('resize', sizeRenderer);

// ── Init flow ──────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  const camOk = await startCamera();
  if (!camOk) {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Scan';
    return;
  }

  const motionOk = await requestMotionPermission();
  if (!motionOk) {
    alert('Motion access was denied. The 3D box will not rotate as you move.\n\nTo enable: Settings → Safari → Motion & Orientation Access → ON.');
  }
  // Don't block — app works without motion, just no orientation anchoring

  // All ready — init scene even without motion
  initScene();
  if (motionOk) {
    startOrientationTracking();
    setAnchor();
  } else {
    console.warn('Motion denied — box will be static (no orientation anchoring)');
  }
  updateVolume();
  animate();

  startOverlay.classList.add('hidden');
  controlsEl.classList.remove('hidden');
  hintEl.classList.remove('hidden');
});

// Show controls initially as hidden
controlsEl.classList.add('hidden');
hintEl.classList.add('hidden');

// Initialize thumb positions at center
dragRows.forEach(row => {
  const { thumb, fillL, fillR } = getDragTrackAndThumb(row);
  const axis = row.dataset.axis;
  const pct = ((dims[axis] - 6) / (144 - 6)) * 100;
  thumb.style.left = pct + '%';
  fillL.style.right = (100 - pct) + '%';
  fillR.style.left = pct + '%';
});
