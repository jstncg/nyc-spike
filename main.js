// Photorealistic NYC, third person. Tiles stream live from Google on every session (ToS). Nothing is stored.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { ReorientationPlugin, GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// ---- config ----
const ORIGIN = { lat: 40.758, lon: -73.9855 }; // Times Square. 1 unit = 1 m, Y up.
const RADIUS = 0.45, WALK = 4, RUN = 9, JUMP = 6, GRAVITY = -20;
const CAR = { accel: 12, brake: 25, maxSpeed: 40, drag: 0.6, turn: 1.6, length: 4.5, width: 1.9 };
const GLIDER = { launch: 300, cruise: 22, min: 10, max: 70, sink: 1.5, turn: 1.1, pitchRate: 1.2, ceiling: 2500 };
const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const { DEG2RAD, RAD2DEG, clamp, lerp } = THREE.MathUtils;
const CREDITS = 'Character: Ready Player Me (three.js examples) · Car: Ferrari 458 by vicent091036 (Sketchfab) · Map: © OpenStreetMap · Search: Photon/komoot';

const $ = id => document.getElementById(id);
if (!KEY) {
  $('loading').textContent = 'Missing VITE_GOOGLE_MAPS_KEY. Copy .env.example to .env and fill it in.';
  throw new Error('missing key');
}

// ---- scene ----
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec8ff);
scene.fog = new THREE.Fog(0x9ec8ff, 2500, 14000); // far haze so distant tiles do not pop
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; // reflections for car paint and skin
scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
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
tiles.errorTarget = 8; // lower = sharper tiles, more requests. 12 was the spike default.
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);
scene.add(tiles.group);

// BVH per tile on load, dropped on unload (runtime collision against in-memory tiles only). Anisotropy sharpens oblique ground textures.
tiles.addEventListener('load-model', ({ scene: s }) => s.traverse(o => {
  if (!o.isMesh) return;
  o.geometry.boundsTree = new MeshBVH(o.geometry);
  if (o.material.map) o.material.map.anisotropy = MAX_ANISO;
}));
tiles.addEventListener('dispose-model', ({ scene: s }) => s.traverse(o => { if (o.isMesh) o.geometry.boundsTree = null; }));

// ---- geo helpers (world <-> lat/lon via the tiles group transform) ----
const _inv = new THREE.Matrix4(), _cart = {};
function worldToLatLon(p) {
  _inv.copy(tiles.group.matrixWorld).invert();
  tiles.ellipsoid.getPositionToCartographic(p.clone().applyMatrix4(_inv), _cart);
  return { lat: _cart.lat * RAD2DEG, lon: _cart.lon * RAD2DEG };
}
function setOrigin(lat, lon, label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`) {
  reorient.lat = lat * DEG2RAD; reorient.lon = lon * DEG2RAD; // survives root tileset refresh
  reorient.transformLatLonHeightToOrigin(reorient.lat, reorient.lon);
  if (car) { scene.remove(car); car = null; }
  setMode('walk');
  beginSpawn(label);
  history.replaceState(null, '', `?at=${lat.toFixed(5)},${lon.toFixed(5)}`);
}

// ---- spawn: hold above the target behind a curtain until ground tiles exist, then place feet on the ground ----
let spawning = false, settledFrames = 0, spawnTimer = 0;
function beginSpawn(label) {
  spawning = true; settledFrames = 0; spawnTimer = 0; vy = 0; grounded = false;
  feet.set(0, 300, 0);
  $('loading').textContent = `Loading ${label}…`;
  $('loading').style.display = 'flex';
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
let camYaw = 0, camPitch = 0.25, orbit = 0, zoom = 1; // orbit = mouse offset from vehicle heading; zoom scales camera distance
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  camYaw -= e.movementX * 0.002; orbit -= e.movementX * 0.002;
  camPitch = clamp(camPitch + e.movementY * 0.002, -0.2, 1.4); // never below the road
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  tiles.setResolutionFromRenderer(camera, renderer);
});

// ---- teleport bar with suggestions (Photon geocoder: free, no key, built for autocomplete) ----
// ponytail: fair-use public instance. Self-host Photon or swap for Google Places before a public launch.
const suggestions = new Map(); // label -> [lat, lon]
const placeLabel = f => [f.properties.name, f.properties.street && f.properties.housenumber ? `${f.properties.housenumber} ${f.properties.street}` : f.properties.street, f.properties.city || f.properties.county, f.properties.state, f.properties.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
async function geocode(q, limit) {
  const here = tiles.root ? worldToLatLon(feet) : ORIGIN;
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lat=${here.lat}&lon=${here.lon}`;
  const r = await fetch(url).then(r => r.json()).catch(() => null);
  return (r?.features || []).map(f => ({ label: placeLabel(f), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
}
let suggestTimer = 0;
$('q').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('q').value.trim();
  if (q.length < 3 || /^\s*-?\d+(\.\d+)?\s*,/.test(q)) return; // skip lat,lon input, keep house numbers
  suggestTimer = setTimeout(async () => {
    const list = await geocode(q, 6);
    if ($('q').value.trim() !== q) return; // stale
    suggestions.clear();
    $('places').replaceChildren(...list.map(p => { suggestions.set(p.label, [p.lat, p.lon]); const o = document.createElement('option'); o.value = p.label; return o; }));
  }, 250);
});
$('go').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  let lat, lon, label = q;
  if (m) [lat, lon] = [+m[1], +m[2]];
  else if (suggestions.has(q)) [lat, lon] = suggestions.get(q);
  else {
    $('q').disabled = true;
    const [hit] = await geocode(q, 1);
    $('q').disabled = false;
    if (!hit) { $('q').value = ''; $('q').placeholder = `Not found: ${q}`; return; }
    ({ lat, lon, label } = hit);
  }
  setOrigin(lat, lon, label.split(',').slice(0, 2).join(','));
  $('q').blur(); $('q').value = '';
});

// ---- models ----
// ponytail: Soldier.glb is loaded only for its Idle/Walk/Run clips (Mixamo rig, same skeleton as the Ready Player Me guy). Bake the clips into one file if 2 MB matters.
const gltf = new GLTFLoader().setDRACOLoader(draco); // ferrari.glb is Draco-compressed
const load = url => new Promise((res, rej) => gltf.load(url, res, undefined, rej));
let mixer, actions = {}, current, carModel = null;
const person = new THREE.Group(); scene.add(person);
const glider = makeGlider(); glider.visible = false; scene.add(glider);

Promise.all([load('/guy.glb'), load('/Soldier.glb')]).then(([m, s]) => {
  const skinned = root => { let r; root.traverse(o => { if (!r && o.isSkinnedMesh) r = o; }); return r; };
  const target = skinned(m.scene);
  m.scene.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; }); // bone-driven meshes outrun their static bounds
  const tint = { Wolf3D_Outfit_Top: 0x2a3550, Wolf3D_Outfit_Bottom: 0x2b2b30, Wolf3D_Outfit_Footwear: 0x222222 }; // the sample avatar wears a pink suit
  m.scene.traverse(o => { if (o.isMesh && tint[o.material?.name] !== undefined) o.material.color.setHex(tint[o.material.name]); });
  mixer = new THREE.AnimationMixer(target);
  for (const clip of s.animations) if (clip.name !== 'TPose') actions[clip.name] = mixer.clipAction(bake(m.scene, s.scene, target, clip));
  person.add(m.scene);
  play('Idle');
  const pilot = cloneSkinned(m.scene); // T-pose, prone under the wing
  pilot.rotation.set(-Math.PI / 2, 0, 0); pilot.position.set(0, -1.0, 0.9);
  glider.add(pilot);
}).catch(err => console.error('character load failed', err));

// Retarget by copying each source bone's world rotation onto the same-named target bone, top down.
// Both are Mixamo T-pose rigs, so bind orientations agree in world space even though local rest poses differ.
// Both model roots must sit at the identity while baking.
function bake(tgtRoot, srcRoot, tgtSkin, clip, fps = 30) {
  const mx = new THREE.AnimationMixer(srcRoot); mx.clipAction(clip).play();
  const bones = []; tgtRoot.traverse(o => { const sb = o.isBone && srcRoot.getObjectByName('mixamorig' + o.name); if (sb) bones.push([o, sb]); }); // RPM bone names lack the mixamorig prefix
  const rest = bones.map(([b]) => [b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  const n = Math.ceil(clip.duration * fps), times = [], quats = bones.map(() => []), hipPos = [];
  const qw = new THREE.Quaternion(), qp = new THREE.Quaternion(), pw = new THREE.Vector3(), inv = new THREE.Matrix4();
  for (let f = 0; f < n; f++) {
    mx.setTime(f / fps); srcRoot.updateMatrixWorld(true); tgtRoot.updateMatrixWorld(true);
    times.push(f / fps);
    bones.forEach(([tb, sb], i) => {
      sb.getWorldQuaternion(qw); tb.parent.getWorldQuaternion(qp);
      tb.quaternion.copy(qp.invert().multiply(qw)); tb.updateMatrixWorld();
      quats[i].push(...tb.quaternion.toArray());
      if (tb.name === 'Hips') { sb.getWorldPosition(pw); pw.applyMatrix4(inv.copy(tb.parent.matrixWorld).invert()); hipPos.push(...pw.toArray()); }
    });
  }
  for (const [b, p, q, sc] of rest) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(sc); }
  const tracks = bones.map(([tb], i) => new THREE.QuaternionKeyframeTrack(`.bones[${tb.name}].quaternion`, times, quats[i]));
  tracks.push(new THREE.VectorKeyframeTrack('.bones[Hips].position', times, hipPos));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

load('/ferrari.glb').then(g => {
  const model = g.scene;
  const body = new THREE.MeshPhysicalMaterial({ color: 0xd0021b, metalness: 1, roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.03 });
  const details = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.5 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.25, roughness: 0, transparent: true, opacity: 0.35 });
  model.getObjectByName('body').material = body;
  for (const n of ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim']) model.getObjectByName(n).material = details;
  model.getObjectByName('glass').material = glass;
  // model already faces -Z (front wheels at negative z), same as our forward
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  model.position.y -= box.min.y; // wheels on the ground
  carModel = model;
}).catch(err => console.error('car load failed', err));

function play(name) {
  if (current === name || !actions[name]) return;
  actions[name].reset().fadeIn(0.2).play();
  if (current) actions[current].fadeOut(0.2);
  current = name;
}

// ---- glider (blue delta wing) ----
function makeGlider() {
  const g = new THREE.Group();
  const wing = (x0, color) => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -4), new THREE.Vector3(x0, 0, 2.5), new THREE.Vector3(0, -0.15, 1.2)]);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, flatShading: true }));
  };
  g.add(wing(-4.5, 0x1e6ff5), wing(4.5, 0x0b4fc2));
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  bar.position.set(0, -0.7, 0); g.add(bar);
  return g;
}

// ---- state ----
const feet = new THREE.Vector3(0, 300, 0);
let vy = 0, grounded = false, yaw = 0, speed = 0, mode = 'walk';
let car = null, carSpeed = 0, wheels = [];
let gYaw = 0, gPitch = 0, gSpeed = 0, gBank = 0;

function setMode(m) {
  mode = m;
  person.visible = m === 'walk';
  glider.visible = m === 'glide';
  orbit = 0;
}
function toggleCar() {
  if (mode === 'glide' || spawning || !carModel) return;
  if (mode === 'walk') {
    if (car) scene.remove(car);
    car = new THREE.Group();
    car.add(carModel.clone());
    wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map(n => car.getObjectByName(n));
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
  if (mode === 'drive' || spawning) return;
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
// First hit below head height; if nothing (we are under a tile that refined above us), the first surface up to 300 m above.
function groundUnder(p) { return cast(tmp.copy(p).setY(p.y + 1.5), DOWN, 3000) || cast(tmp.copy(p).setY(p.y + 300), DOWN, 302); }

function stepWalk(dt) {
  if (spawning) {
    const ground = groundUnder(feet);
    settledFrames = tiles.loadProgress >= 1 ? settledFrames + 1 : 0; // the queue empties briefly between refinement rounds
    spawnTimer += dt;
    if (!ground || (settledFrames < 30 && spawnTimer < 8)) return; // settled, or 8 s cap so a busy area cannot hold the curtain forever
    feet.y = ground.point.y; grounded = true; spawning = false;
    $('loading').style.display = 'none';
  }
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
    if (ground.point.y > feet.y + 0.05 && vy <= 0) { feet.y = ground.point.y; vy = 0; grounded = true; } // surface refined above us: pop up onto it
    else if (nextY <= ground.point.y + 0.01 && vy <= 0) { feet.y = ground.point.y; vy = 0; grounded = true; }
    else { feet.y = nextY; grounded = false; }
  } else vy = 0; // tile under us unloaded: hold altitude instead of falling through the earth
  person.position.copy(feet);
  person.rotation.y = yaw; // this avatar faces -Z, same as our forward
  play(!grounded || speed === 0 ? 'Idle' : speed > WALK ? 'Run' : 'Walk');
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
  for (const w of wheels) if (w) w.rotation.x -= carSpeed * dt / 0.36;
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
  if (spawning) { // look straight down so the ground tiles under the spawn point load first
    camera.position.copy(feet);
    camera.lookAt(feet.x, feet.y - 100, feet.z - 1);
    return;
  }
  const anchor = mode === 'drive' ? car.position : mode === 'glide' ? glider.position : feet;
  const focus = anchor.clone(); focus.y += mode === 'drive' ? 1.6 : mode === 'glide' ? 0.5 : 1.5;
  const dist = (mode === 'drive' ? 9 : mode === 'glide' ? 14 : 5) * zoom;
  const off = new THREE.Vector3(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch)).multiplyScalar(dist);
  const hit = mode !== 'glide' && cast(focus, tmp2.copy(off).normalize(), dist);
  if (hit) off.setLength(Math.max(0.5, hit.distance - 0.3));
  camera.position.copy(focus).add(off);
  camera.lookAt(focus);
}

// ---- minimap: GTA style, bottom right, circular, rotates so your heading is up ----
// ponytail: tile.openstreetmap.org is fine for a prototype, not for public launch. Swap host before shipping.
const mm = $('minimap'), mctx = mm.getContext('2d'), tileCache = new Map();
let mmZoom = 0; // user offset on top of the per-mode zoom level
const mmView = {}; // what the last frame drew, for click-to-teleport
mm.addEventListener('wheel', e => { e.preventDefault(); mmZoom = clamp(mmZoom - Math.sign(e.deltaY), -4, 3); }, { passive: false });
$('zin').addEventListener('click', () => { mmZoom = Math.min(3, mmZoom + 1); });
$('zout').addEventListener('click', () => { mmZoom = Math.max(-4, mmZoom - 1); });
mm.addEventListener('click', e => {
  if (!mmView.n || spawning) return;
  const rect = mm.getBoundingClientRect(), k = mm.width / rect.width;
  const px = (e.clientX - rect.left) * k - mm.width / 2, py = (e.clientY - rect.top) * k - mm.height / 2;
  if (px * px + py * py > (mm.width / 2 - 6) ** 2) return; // outside the disc
  const c = Math.cos(mmView.bearing), sn = Math.sin(mmView.bearing); // undo the heading-up rotation
  const ux = px * c - py * sn, uy = px * sn + py * c;
  const tx = mmView.tx + ux / 256, ty = mmView.ty + uy / 256;
  const lon = tx / mmView.n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / mmView.n))) * RAD2DEG;
  setOrigin(lat, lon);
});
function osmTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!tileCache.has(k)) { const im = new Image(); im.src = `https://tile.openstreetmap.org/${k}.png`; tileCache.set(k, im); }
  return tileCache.get(k);
}
function drawMinimap() {
  if (!tiles.root) return; // no tileset yet: group transform is identity
  const p = mode === 'drive' ? car.position : mode === 'glide' ? glider.position : feet;
  const heading = mode === 'drive' ? car.rotation.y : mode === 'glide' ? gYaw : yaw;
  const Z = clamp((mode === 'glide' ? 14 : mode === 'drive' ? 16 : 17) + mmZoom, 3, 19);
  const { lat, lon } = worldToLatLon(p);
  const n = 2 ** Z, latR = lat * DEG2RAD;
  const tx = (lon + 180) / 360 * n, ty = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const W = mm.width, cx = W / 2, cy = W / 2, r = W / 2 - 6, S = 256;
  // bearing of the heading: from two world points, no axis assumptions
  const ahead = worldToLatLon(p.clone().add(fwdOf(heading).multiplyScalar(10)));
  const bearing = Math.atan2((ahead.lon - lon) * Math.cos(latR), ahead.lat - lat);
  Object.assign(mmView, { tx, ty, n, bearing });
  mctx.clearRect(0, 0, W, W);
  mctx.save();
  mctx.beginPath(); mctx.arc(cx, cy, r, 0, Math.PI * 2); mctx.clip();
  mctx.fillStyle = '#223'; mctx.fillRect(0, 0, W, W);
  mctx.translate(cx, cy); mctx.rotate(-bearing); // heading up
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const im = osmTile(Z, Math.floor(tx) + dx, Math.floor(ty) + dy);
    if (im.complete && im.naturalWidth) mctx.drawImage(im, (Math.floor(tx) + dx - tx) * S, (Math.floor(ty) + dy - ty) * S, S, S);
  }
  // north marker on the rim
  mctx.fillStyle = '#fff'; mctx.font = 'bold 12px monospace'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
  mctx.fillStyle = 'rgba(0,0,0,.6)'; mctx.beginPath(); mctx.arc(0, -r + 12, 9, 0, Math.PI * 2); mctx.fill();
  mctx.fillStyle = '#ff3b30'; mctx.fillText('N', 0, -r + 12);
  mctx.restore();
  // rim + player arrow (fixed, pointing up)
  mctx.lineWidth = 4; mctx.strokeStyle = 'rgba(255,255,255,.85)';
  mctx.beginPath(); mctx.arc(cx, cy, r, 0, Math.PI * 2); mctx.stroke();
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#000'; mctx.lineWidth = 2;
  mctx.beginPath(); mctx.moveTo(cx, cy - 11); mctx.lineTo(cx + 8, cy + 8); mctx.lineTo(cx, cy + 3); mctx.lineTo(cx - 8, cy + 8); mctx.closePath();
  mctx.fill(); mctx.stroke();
  $('coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// ---- boot ----
const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
let pendingAt = at?.length === 2 && at.every(Number.isFinite) ? at : null; // applied once the root tileset exists (see loop)
beginSpawn(pendingAt ? `${at[0]}, ${at[1]}` : 'Times Square');


// ---- loop ----
const hud = $('hud'), attribution = $('attribution');
const clock = new THREE.Clock();
let mmTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (pendingAt && tiles.root) { setOrigin(pendingAt[0], pendingAt[1]); pendingAt = null; }
  if (keys.has('ArrowUp')) zoom = Math.max(0.3, zoom * Math.exp(-2 * dt));
  if (keys.has('ArrowDown')) zoom = Math.min(6, zoom * Math.exp(2 * dt));
  if (mode === 'drive') stepDrive(dt); else if (mode === 'glide') stepGlide(dt); else stepWalk(dt);
  mixer?.update(dt);
  updateCamera();
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  if ((mmTimer += dt) > 0.08) { mmTimer = 0; drawMinimap(); }
  hud.textContent = mode === 'drive'
    ? `${Math.abs(carSpeed * 3.6).toFixed(0)} km/h\nWS gas/reverse · AD steer · Space brake · V exit`
    : mode === 'glide'
      ? `${(gSpeed * 3.6).toFixed(0)} km/h · ${glider.position.y.toFixed(0)} m\nW dive · S climb · AD turn · Shift sprint · H land`
      : `${grounded ? '' : 'air · '}WASD move · Shift run · Space jump · V car · H glider · ↑↓ zoom · click to look`;
  attribution.textContent = [...tiles.getAttributions().map(a => a.value), CREDITS].join(' · ');
});
