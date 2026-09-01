// Photorealistic NYC, third person. Tiles stream live from Google on every session (ToS). Nothing is stored.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { ReorientationPlugin, GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// ---- config ----
const ORIGIN = { lat: 40.758, lon: -73.9855 }; // Times Square. 1 unit = 1 m, Y up.
const RADIUS = 0.45, WALK = 4, RUN = 9, JUMP = 6, GRAVITY = -20;
const CAR = { accel: 12, brake: 25, maxSpeed: 40, drag: 0.6, turn: 1.6, length: 4.4, width: 1.9 };
const GLIDER = { launch: 300, cruise: 22, min: 10, max: 70, sink: 1.5, turn: 1.1, pitchRate: 1.2, ceiling: 2500 };
const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const { DEG2RAD, RAD2DEG, clamp, lerp } = THREE.MathUtils;

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
scene.fog = new THREE.Fog(0x9ec8ff, 2500, 14000); // far haze so distant tiles do not pop
scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(50, 100, 30);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 30000);

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
  setMode('walk');
  history.replaceState(null, '', `?at=${lat.toFixed(5)},${lon.toFixed(5)}`);
}

// ---- input ----
const keys = new Set();
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyV') toggleCar();
  if (e.code === 'KeyH') toggleGlider();
});
addEventListener('keyup', e => keys.delete(e.code));
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
let camYaw = 0, camPitch = 0.25, orbit = 0; // orbit = mouse offset from vehicle heading
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  camYaw -= e.movementX * 0.002; orbit -= e.movementX * 0.002;
  camPitch = clamp(camPitch + e.movementY * 0.002, -1.0, 1.4);
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
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
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

// ---- low-poly person (primitives) ----
const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, ...extra });
const box = (w, h, d, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
function makePerson() {
  const skin = flat(0xf1c27d), shirt = flat(0x2f80ed), pants = flat(0x2b3140), shoe = flat(0x14161a), hair = flat(0x3b2415);
  const g = new THREE.Group();
  g.add(box(0.38, 0.52, 0.22, shirt, 0, 1.16, 0));            // torso
  g.add(box(0.24, 0.26, 0.24, skin, 0, 1.58, 0));             // head
  g.add(box(0.26, 0.08, 0.26, hair, 0, 1.72, 0));             // hair
  g.add(box(0.06, 0.04, 0.02, flat(0x111111), -0.06, 1.6, 0.125)); // eyes
  g.add(box(0.06, 0.04, 0.02, flat(0x111111), 0.06, 1.6, 0.125));
  const limb = (w, h, d, mat, x, y, tipMat, tipH) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    pivot.add(box(w, h, d, mat, 0, -h / 2, 0));
    if (tipMat) pivot.add(box(w + 0.02, tipH, d + 0.08, tipMat, 0, -h - tipH / 2, 0.03));
    g.add(pivot); return pivot;
  };
  g.userData.armL = limb(0.11, 0.5, 0.11, shirt, -0.26, 1.38, skin, 0.1);
  g.userData.armR = limb(0.11, 0.5, 0.11, shirt, 0.26, 1.38, skin, 0.1);
  g.userData.legL = limb(0.15, 0.8, 0.15, pants, -0.1, 0.9, shoe, 0.1);
  g.userData.legR = limb(0.15, 0.8, 0.15, pants, 0.1, 0.9, shoe, 0.1);
  g.rotation.y = Math.PI; // face -Z (our forward)
  return g;
}
let phase = 0;
function animatePerson(p, speed, dt) {
  const { armL, armR, legL, legR } = p.userData;
  phase += speed * dt * 1.6;
  const amp = speed === 0 ? 0 : speed > WALK ? 0.9 : 0.6;
  const s = Math.sin(phase) * amp;
  legL.rotation.x = s; legR.rotation.x = -s;
  armL.rotation.x = -s; armR.rotation.x = s;
  p.position.y += speed === 0 ? 0 : Math.abs(Math.cos(phase)) * 0.04;
}

// ---- car (primitives; nothing derived from tiles) ----
function makeCar() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xd62828, metalness: 0.5, roughness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2a3a, metalness: 0.9, roughness: 0.1 });
  const dark = flat(0x1a1a1a), hub = flat(0x999999);
  g.add(box(CAR.width, 0.5, CAR.length, paint, 0, 0.6, 0));                    // body
  g.add(box(CAR.width - 0.25, 0.48, 2.2, paint, 0, 1.08, 0.15));               // cabin
  const wind = box(CAR.width - 0.35, 0.46, 0.06, glass, 0, 1.08, -0.95); wind.rotation.x = -0.45; g.add(wind);
  const rear = box(CAR.width - 0.35, 0.46, 0.06, glass, 0, 1.08, 1.25); rear.rotation.x = 0.5; g.add(rear);
  g.add(box(0.06, 0.4, 1.9, glass, -(CAR.width - 0.25) / 2, 1.08, 0.15), box(0.06, 0.4, 1.9, glass, (CAR.width - 0.25) / 2, 1.08, 0.15)); // side windows
  g.add(box(CAR.width + 0.05, 0.12, 0.3, dark, 0, 0.42, -CAR.length / 2), box(CAR.width + 0.05, 0.12, 0.3, dark, 0, 0.42, CAR.length / 2)); // bumpers
  const lamp = (color, x, z) => g.add(box(0.3, 0.12, 0.05, flat(color, { emissive: color, emissiveIntensity: 1.5 }), x, 0.72, z));
  lamp(0xfff2b0, -0.65, -CAR.length / 2 - 0.02); lamp(0xfff2b0, 0.65, -CAR.length / 2 - 0.02);
  lamp(0xff2020, -0.65, CAR.length / 2 + 0.02); lamp(0xff2020, 0.65, CAR.length / 2 + 0.02);
  const tire = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 18).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.3, 8).rotateZ(Math.PI / 2);
  g.userData.wheels = [[-0.9, -1.45], [0.9, -1.45], [-0.9, 1.45], [0.9, 1.45]].map(([x, z]) => {
    const w = new THREE.Group(); w.position.set(x, 0.36, z);
    w.add(new THREE.Mesh(tire, dark), new THREE.Mesh(rim, hub));
    g.add(w); return w;
  });
  return g;
}

// ---- glider (blue delta wing, pilot hangs under it) ----
function makeGlider() {
  const g = new THREE.Group();
  const wing = (x0, color) => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -4), new THREE.Vector3(x0, 0, 2.5), new THREE.Vector3(0, -0.15, 1.2)]);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, flatShading: true }));
  };
  g.add(wing(-4.5, 0x1e6ff5), wing(4.5, 0x0b4fc2));
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4), flat(0xdddddd)); bar.position.set(0, -0.7, 0); g.add(bar);
  const pilot = makePerson(); pilot.rotation.set(-Math.PI / 2, Math.PI, 0); pilot.position.set(0, -1.1, 0.9); // prone under the wing
  pilot.userData.armL.rotation.x = pilot.userData.armR.rotation.x = -1.4; // reaching for the bar
  g.add(pilot);
  return g;
}

// ---- state ----
const feet = new THREE.Vector3(0, 300, 0); // drop in from above; gravity is held until ground tiles exist
let vy = 0, grounded = false, yaw = 0, speed = 0, mode = 'walk';
const person = makePerson(); scene.add(person);
let car = null, carSpeed = 0;
const glider = makeGlider(); glider.visible = false; scene.add(glider);
let gYaw = 0, gPitch = 0, gSpeed = 0, gBank = 0;

function setMode(m) {
  mode = m;
  person.visible = m === 'walk';
  glider.visible = m === 'glide';
  orbit = 0;
}
function toggleCar() {
  if (mode === 'glide') return;
  if (mode === 'walk') {
    if (car) scene.remove(car);
    car = makeCar();
    car.position.copy(feet).addScaledVector(fwdOf(yaw), 3);
    car.rotation.y = yaw; carSpeed = 0;
    scene.add(car);
    setMode('drive');
  } else {
    feet.copy(car.position).addScaledVector(rightOf(car.rotation.y), 2).setY(car.position.y);
    yaw = car.rotation.y; camYaw = car.rotation.y + orbit; vy = 0;
    setMode('walk');
  }
}
function toggleGlider() {
  if (mode === 'drive') return;
  if (mode === 'walk') {
    glider.position.copy(feet).addScaledVector(fwdOf(camYaw), 4); glider.position.y += GLIDER.launch;
    gYaw = camYaw; gPitch = 0; gSpeed = GLIDER.cruise; gBank = 0;
    setMode('glide');
  } else land();
}
function land() {
  feet.copy(glider.position); yaw = gYaw; camYaw = gYaw + orbit; vy = -2; grounded = false;
  setMode('walk');
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
function groundUnder(p) { return cast(tmp.copy(p).setY(p.y + 1.5), DOWN, 3000); }

function stepWalk(dt) {
  const fwd = fwdOf(camYaw), right = rightOf(camYaw);
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(fwd);
  if (keys.has('KeyS')) move.sub(fwd);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  speed = 0;
  if (move.lengthSq() > 0) {
    speed = keys.has('ShiftLeft') ? RUN : WALK;
    const target = Math.atan2(-move.x, -move.z);
    let d = target - yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw += d * Math.min(1, 12 * dt);
    move.normalize().multiplyScalar(speed * dt);
    feet.add(slide(move, feet.clone().setY(feet.y + 1)));
  }
  if (grounded && keys.has('Space')) vy = JUMP;
  vy += GRAVITY * dt;
  const ground = groundUnder(feet);
  if (ground) {
    const nextY = feet.y + vy * dt;
    if (nextY <= ground.point.y + 0.01 && vy <= 0) { feet.y = ground.point.y; vy = 0; grounded = true; }
    else { feet.y = nextY; grounded = false; }
  } else vy = 0; // no tiles under us yet: hold altitude instead of falling through the earth
  person.position.copy(feet);
  person.rotation.y = yaw + Math.PI;
  animatePerson(person, grounded ? speed : 0, dt);
}

function stepDrive(dt) {
  const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
  carSpeed += throttle * (throttle * carSpeed < 0 ? CAR.brake : CAR.accel) * dt;
  carSpeed -= carSpeed * CAR.drag * dt;
  carSpeed = clamp(carSpeed, -CAR.maxSpeed / 3, CAR.maxSpeed);
  if (keys.has('Space')) carSpeed -= Math.sign(carSpeed) * Math.min(Math.abs(carSpeed), CAR.brake * 2 * dt);
  car.rotation.y += steer * CAR.turn * (carSpeed / CAR.maxSpeed) * dt * 3;
  const move = fwdOf(car.rotation.y).multiplyScalar(carSpeed * dt);
  const bumper = car.position.clone().setY(car.position.y + 0.6);
  const hit = carSpeed && cast(bumper, tmp2.copy(move).normalize(), Math.abs(carSpeed * dt) + CAR.length / 2);
  if (hit) carSpeed = 0; else car.position.add(move);
  const ground = groundUnder(car.position);
  if (ground) car.position.y += (ground.point.y - car.position.y) * Math.min(1, 10 * dt);
  for (const w of car.userData.wheels) w.rotation.x -= carSpeed * dt / 0.36;
  camYaw = car.rotation.y + orbit; // orbit = free mouse look, follows the car as it turns
}

function stepGlide(dt) {
  const pitchIn = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0); // S nose up, W nose down
  const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
  gPitch = clamp(gPitch + pitchIn * GLIDER.pitchRate * dt, -0.9, 0.45);
  gBank = lerp(gBank, steer * 0.7, Math.min(1, 4 * dt));
  gYaw += steer * GLIDER.turn * dt;
  // gravity along the nose, drag toward cruise speed
  gSpeed += (-9.8 * Math.sin(gPitch) - 0.4 * (gSpeed - GLIDER.cruise)) * dt;
  if (keys.has('ShiftLeft')) gSpeed += 30 * dt; // sprint: push toward max speed
  gSpeed = clamp(gSpeed, GLIDER.min, GLIDER.max);
  const dir = new THREE.Vector3(-Math.sin(gYaw) * Math.cos(gPitch), Math.sin(gPitch), -Math.cos(gYaw) * Math.cos(gPitch));
  const move = dir.clone().multiplyScalar(gSpeed * dt); move.y -= GLIDER.sink * dt;
  const hit = cast(glider.position, tmp2.copy(move).normalize(), move.length() + 3);
  if (hit) { glider.position.copy(hit.point).addScaledVector(tmp2, -2); return land(); }
  glider.position.add(move);
  glider.position.y = Math.min(glider.position.y, GLIDER.ceiling);
  const ground = groundUnder(glider.position);
  if (ground && glider.position.y - ground.point.y < 2.5) return land();
  glider.rotation.set(0, 0, 0); glider.rotateY(gYaw); glider.rotateX(gPitch); glider.rotateZ(gBank);
  camYaw = gYaw + orbit;
}

// ---- camera ----
function updateCamera() {
  const anchor = mode === 'drive' ? car.position : mode === 'glide' ? glider.position : feet;
  const focus = anchor.clone(); focus.y += mode === 'drive' ? 1.6 : mode === 'glide' ? 0.5 : 1.5;
  const dist = mode === 'drive' ? 9 : mode === 'glide' ? 14 : 5;
  const pitch = camPitch;
  const off = new THREE.Vector3(Math.sin(camYaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(camYaw) * Math.cos(pitch)).multiplyScalar(dist);
  const hit = cast(focus, tmp2.copy(off).normalize(), dist);
  if (hit) off.setLength(Math.max(0.5, hit.distance - 0.3));
  camera.position.copy(focus).add(off);
  camera.lookAt(focus);
}

// ---- minimap (OSM raster tiles, north up) ----
// ponytail: tile.openstreetmap.org is fine for a prototype, not for public launch. Swap host before shipping.
const mm = $('minimap'), mctx = mm.getContext('2d'), tileCache = new Map();
function osmTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!tileCache.has(k)) { const im = new Image(); im.src = `https://tile.openstreetmap.org/${k}.png`; tileCache.set(k, im); }
  return tileCache.get(k);
}
function drawMinimap() {
  const p = mode === 'drive' ? car.position : mode === 'glide' ? glider.position : feet;
  const heading = mode === 'drive' ? car.rotation.y : mode === 'glide' ? gYaw : camYaw;
  const Z = mode === 'glide' ? 14 : 16; // zoom out in the air
  const { lat, lon } = worldToLatLon(p);
  if (!tiles.root) return; // no tileset yet: group transform is identity
  const n = 2 ** Z, latR = lat * DEG2RAD;
  const tx = (lon + 180) / 360 * n, ty = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const cx = mm.width / 2, cy = mm.height / 2, S = 256;
  mctx.fillStyle = '#223'; mctx.fillRect(0, 0, mm.width, mm.height);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const im = osmTile(Z, Math.floor(tx) + dx, Math.floor(ty) + dy);
    if (im.complete && im.naturalWidth) mctx.drawImage(im, cx + (Math.floor(tx) + dx - tx) * S, cy + (Math.floor(ty) + dy - ty) * S, S, S);
  }
  // heading arrow: bearing from two world points, no axis assumptions
  const ahead = worldToLatLon(p.clone().add(fwdOf(heading).multiplyScalar(10)));
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
  if (mode === 'drive') stepDrive(dt); else if (mode === 'glide') stepGlide(dt); else stepWalk(dt);
  updateCamera();
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  if ((mmTimer += dt) > 0.1) { mmTimer = 0; drawMinimap(); }
  hud.textContent = mode === 'drive'
    ? `${Math.abs(carSpeed * 3.6).toFixed(0)} km/h\nWS gas/reverse · AD steer · Space brake · V exit`
    : mode === 'glide'
      ? `${(gSpeed * 3.6).toFixed(0)} km/h · ${glider.position.y.toFixed(0)} m\nW dive · S climb · AD turn · Shift sprint · H land`
      : `${grounded ? '' : 'air · '}WASD move · Shift run · Space jump · V car · H glider · click to look`;
  attribution.textContent = tiles.getAttributions().map(a => a.value).join(' · ');
});
