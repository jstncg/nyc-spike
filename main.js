// Photorealistic NYC, third person. Tiles stream live from Google on every session (ToS). Nothing is stored.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { ReorientationPlugin, GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// ---- config ----
const ORIGIN = { lat: 40.758, lon: -73.9855 }; // Times Square. 1 unit = 1 m, Y up.
const RADIUS = 0.45, WALK = 4, RUN = 9, JUMP = 6, GRAVITY = -20;
const CAR = { accel: 12, brake: 25, maxSpeed: 40, drag: 0.6, turn: 1.6, length: 4.4, width: 1.9 };
const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const { DEG2RAD, RAD2DEG } = THREE.MathUtils;

const $ = id => document.getElementById(id);
if (!KEY) {
  $('hud').textContent = 'Missing VITE_GOOGLE_MAPS_KEY. Copy .env.example to .env and fill it in.';
  throw new Error('missing key');
}

// ---- scene ----
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec8ff);
scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 2.5));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(50, 100, 30);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 20000);

const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const tiles = new TilesRenderer();
const reorient = new ReorientationPlugin({ lat: DEG2RAD * ORIGIN.lat, lon: DEG2RAD * ORIGIN.lon, recenter: true });
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: KEY, autoRefreshToken: true }));
tiles.registerPlugin(reorient);
tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
tiles.registerPlugin(new TilesFadePlugin());
tiles.errorTarget = 12;
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);
scene.add(tiles.group);

// BVH per tile on load, dropped on unload (runtime collision against in-memory tiles only).
tiles.addEventListener('load-model', ({ scene: s }) => s.traverse(o => { if (o.isMesh) o.geometry.boundsTree = new MeshBVH(o.geometry); }));
tiles.addEventListener('dispose-model', ({ scene: s }) => s.traverse(o => { if (o.isMesh) o.geometry.boundsTree = null; }));

// ---- geo helpers (world <-> lat/lon via the tiles group transform) ----
const _inv = new THREE.Matrix4(), _cart = {};
function worldToLatLon(p) {
  _inv.copy(tiles.group.matrixWorld).invert();
  tiles.ellipsoid.getPositionToCartographic(p.clone().applyMatrix4(_inv), _cart);
  return { lat: _cart.lat * RAD2DEG, lon: _cart.lon * RAD2DEG };
}
function setOrigin(lat, lon) {
  reorient.lat = lat * DEG2RAD; reorient.lon = lon * DEG2RAD; // survives root tileset refresh
  reorient.transformLatLonHeightToOrigin(reorient.lat, reorient.lon);
  feet.set(0, 300, 0); vy = 0; grounded = false;
  if (car) { scene.remove(car); car = null; }
  mode = 'walk'; soldier.visible = true;
  history.replaceState(null, '', `?at=${lat.toFixed(5)},${lon.toFixed(5)}`);
}

// ---- input ----
const keys = new Set();
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyV') toggleCar();
});
addEventListener('keyup', e => keys.delete(e.code));
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
let camYaw = 0, camPitch = 0.25, orbit = 0; // orbit = mouse offset from car heading while driving
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  camYaw -= e.movementX * 0.002; orbit -= e.movementX * 0.002;
  camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.002, -0.3, 1.2);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  tiles.setResolutionFromRenderer(camera, renderer);
});

// ---- teleport bar ----
$('go').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  let m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  let lat, lon;
  if (m) [lat, lon] = [+m[1], +m[2]];
  else {
    $('q').disabled = true;
    // ponytail: Nominatim free tier, 1 req/s, no key. Swap for Google Geocoding if it rate-limits you.
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => []);
    $('q').disabled = false;
    if (!r[0]) { $('q').value = ''; $('q').placeholder = `Not found: ${q}`; return; }
    [lat, lon] = [+r[0].lat, +r[0].lon];
  }
  setOrigin(lat, lon);
  $('q').blur(); $('q').value = '';
});

// ---- character ----
const feet = new THREE.Vector3(0, 300, 0); // drop in from above; gravity is held until ground tiles exist
let vy = 0, grounded = false, yaw = 0, speed = 0;
const soldier = new THREE.Group();
scene.add(soldier);
let mixer, actions = {}, current;
new GLTFLoader().load('/Soldier.glb', g => {
  soldier.add(g.scene);
  mixer = new THREE.AnimationMixer(g.scene);
  for (const c of g.animations) actions[c.name] = mixer.clipAction(c);
  play('Idle');
});
function play(name) {
  if (current === name || !actions[name]) return;
  actions[name].reset().fadeIn(0.2).play();
  if (current) actions[current].fadeOut(0.2);
  current = name;
}

// ---- car (primitives; nothing derived from tiles) ----
let car = null, carSpeed = 0, mode = 'walk';
function makeCar() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xd62828, metalness: 0.4, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(CAR.width, 0.55, CAR.length), paint); body.position.y = 0.6;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(CAR.width - 0.3, 0.55, 2.1), dark); cabin.position.set(0, 1.15, -0.2);
  g.add(body, cabin);
  const wheel = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 16).rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.85, 1.4], [0.85, 1.4], [-0.85, -1.4], [0.85, -1.4]]) {
    const w = new THREE.Mesh(wheel, dark); w.position.set(x, 0.35, z); g.add(w);
  }
  return g;
}
function toggleCar() {
  if (mode === 'walk') {
    if (car) scene.remove(car);
    car = makeCar();
    car.position.copy(feet).addScaledVector(fwdOf(yaw), 3);
    car.rotation.y = yaw; carSpeed = 0;
    scene.add(car);
    mode = 'drive'; soldier.visible = false; orbit = 0;
  } else {
    mode = 'walk'; soldier.visible = true;
    feet.copy(car.position).addScaledVector(rightOf(car.rotation.y), 2).setY(car.position.y);
    yaw = car.rotation.y; camYaw = car.rotation.y + orbit; vy = 0;
  }
}

// ---- physics ----
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const fwdOf = y => new THREE.Vector3(-Math.sin(y), 0, -Math.cos(y));
const rightOf = y => new THREE.Vector3(Math.cos(y), 0, -Math.sin(y));
function cast(origin, dir, far) {
  ray.set(origin, dir);
  ray.far = far;
  return ray.intersectObject(tiles.group, true)[0];
}
function slide(move, origin) {
  // walls: one ray along the move; slide along the hit surface.
  // ponytail: single ray, no capsule shapecast. Upgrade to capsule shapecast if you clip corners.
  const hit = cast(origin, tmp2.copy(move).normalize(), move.length() + RADIUS);
  if (hit) {
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).setY(0).normalize();
    move.sub(n.multiplyScalar(move.dot(n)));
  }
  return move;
}
function groundUnder(p) { return cast(tmp.copy(p).setY(p.y + 1.5), DOWN, 2000); }

function stepWalk(dt) {
  const fwd = fwdOf(camYaw), right = rightOf(camYaw);
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(fwd);
  if (keys.has('KeyS')) move.sub(fwd);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  const running = keys.has('ShiftLeft');
  speed = 0;
  if (move.lengthSq() > 0) {
    speed = running ? RUN : WALK;
    const target = Math.atan2(-move.x, -move.z);
    let d = target - yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw += d * Math.min(1, 12 * dt);
    move.normalize().multiplyScalar(speed * dt);
    feet.add(slide(move, feet.clone().setY(feet.y + 1)));
  }
  if (grounded && keys.has('Space')) vy = JUMP;
  vy += GRAVITY * dt;
  const ground = groundUnder(feet);
  if (!ground) { vy = 0; return; } // no tiles under us yet: hold altitude instead of falling through the earth
  const nextY = feet.y + vy * dt;
  if (nextY <= ground.point.y + 0.01 && vy <= 0) { feet.y = ground.point.y; vy = 0; grounded = true; }
  else { feet.y = nextY; grounded = false; }
  soldier.position.copy(feet);
  soldier.rotation.y = yaw;
  play(!grounded ? 'Idle' : speed === 0 ? 'Idle' : running ? 'Run' : 'Walk');
}

function stepDrive(dt) {
  const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
  if (throttle * carSpeed < 0) carSpeed += throttle * CAR.brake * dt; // braking
  else carSpeed += throttle * CAR.accel * dt;
  carSpeed -= carSpeed * CAR.drag * dt;
  carSpeed = THREE.MathUtils.clamp(carSpeed, -CAR.maxSpeed / 3, CAR.maxSpeed);
  if (keys.has('Space')) carSpeed -= Math.sign(carSpeed) * Math.min(Math.abs(carSpeed), CAR.brake * 2 * dt);
  car.rotation.y += steer * CAR.turn * (carSpeed / CAR.maxSpeed) * dt * 3;
  const move = fwdOf(car.rotation.y).multiplyScalar(carSpeed * dt);
  const bumper = car.position.clone().setY(car.position.y + 0.6);
  const hit = carSpeed && cast(bumper, tmp2.copy(move).normalize(), Math.abs(carSpeed * dt) + CAR.length / 2);
  if (hit) carSpeed = 0; else car.position.add(move);
  const ground = groundUnder(car.position);
  if (ground) car.position.y += (ground.point.y - car.position.y) * Math.min(1, 10 * dt);
  orbit *= Math.exp(-2 * dt); // camera drifts back behind the car
  camYaw = car.rotation.y + orbit;
}

// ---- camera ----
function updateCamera() {
  const focus = (mode === 'drive' ? car.position : feet).clone();
  focus.y += mode === 'drive' ? 1.6 : 1.5;
  const dist = mode === 'drive' ? 9 : 5;
  const off = new THREE.Vector3(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch)).multiplyScalar(dist);
  const hit = cast(focus, tmp2.copy(off).normalize(), dist);
  if (hit) off.setLength(Math.max(0.5, hit.distance - 0.3));
  camera.position.copy(focus).add(off);
  camera.lookAt(focus);
}

// ---- minimap (OSM raster tiles, north up) ----
// ponytail: tile.openstreetmap.org is fine for a prototype, not for public launch. Swap host before shipping.
const mm = $('minimap'), mctx = mm.getContext('2d'), Z = 16, tileCache = new Map();
function osmTile(x, y) {
  const k = `${x}/${y}`;
  if (!tileCache.has(k)) { const im = new Image(); im.src = `https://tile.openstreetmap.org/${Z}/${x}/${y}.png`; tileCache.set(k, im); }
  return tileCache.get(k);
}
function drawMinimap() {
  const p = mode === 'drive' ? car.position : feet;
  const { lat, lon } = worldToLatLon(p);
  const n = 2 ** Z, latR = lat * DEG2RAD;
  const tx = (lon + 180) / 360 * n, ty = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const cx = mm.width / 2, cy = mm.height / 2, S = 256;
  mctx.fillStyle = '#223'; mctx.fillRect(0, 0, mm.width, mm.height);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const im = osmTile(Math.floor(tx) + dx, Math.floor(ty) + dy);
    if (im.complete && im.naturalWidth) mctx.drawImage(im, cx + (Math.floor(tx) + dx - tx) * S, cy + (Math.floor(ty) + dy - ty) * S, S, S);
  }
  // heading arrow: bearing from two world points, no axis assumptions
  const ahead = worldToLatLon(p.clone().add(fwdOf(mode === 'drive' ? car.rotation.y : camYaw).multiplyScalar(10)));
  const bearing = Math.atan2((ahead.lon - lon) * Math.cos(latR), ahead.lat - lat);
  mctx.save(); mctx.translate(cx, cy); mctx.rotate(bearing);
  mctx.fillStyle = '#ff3b30'; mctx.beginPath(); mctx.moveTo(0, -10); mctx.lineTo(6, 6); mctx.lineTo(-6, 6); mctx.closePath(); mctx.fill();
  mctx.restore();
  $('coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// ---- boot from URL ----
const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
if (at?.length === 2 && at.every(Number.isFinite)) tiles.addEventListener('load-tile-set', () => setOrigin(at[0], at[1]), { once: true });

// ---- loop ----
const hud = $('hud'), attribution = $('attribution');
const clock = new THREE.Clock();
let mmTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (mode === 'drive') stepDrive(dt); else stepWalk(dt);
  mixer?.update(dt);
  updateCamera();
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  if ((mmTimer += dt) > 0.1) { mmTimer = 0; drawMinimap(); }
  hud.textContent = mode === 'drive'
    ? `${Math.abs(carSpeed * 3.6).toFixed(0)} km/h\nWS gas/reverse · AD steer · Space brake · V exit`
    : `${grounded ? '' : 'air · '}WASD move · Shift run · Space jump · V car · click to look`;
  attribution.textContent = tiles.getAttributions().map(a => a.value).join(' · ');
});
