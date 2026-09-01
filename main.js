// Phase 0 spike: walk around photorealistic Manhattan with gravity + wall collision.
// Tiles stream live from Google on every session (ToS). Nothing is stored.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { ReorientationPlugin, GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// ---- config ----
const ORIGIN = { lat: 40.758, lon: -73.9855 }; // Times Square. 1 unit = 1 m, Y up.
const EYE = 1.7, RADIUS = 0.45, WALK = 4, RUN = 9, JUMP = 6, GRAVITY = -20;
const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;

if (!KEY) {
  document.getElementById('hud').textContent = 'Missing VITE_GOOGLE_MAPS_KEY. Copy .env.example to .env and fill it in.';
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
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.5, 20000);
camera.rotation.order = 'YXZ';

const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const tiles = new TilesRenderer();
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: KEY, autoRefreshToken: true }));
tiles.registerPlugin(new ReorientationPlugin({ lat: THREE.MathUtils.DEG2RAD * ORIGIN.lat, lon: THREE.MathUtils.DEG2RAD * ORIGIN.lon, recenter: true }));
tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
tiles.registerPlugin(new TilesFadePlugin());
tiles.errorTarget = 12;
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);
scene.add(tiles.group);

// BVH per tile on load, dropped on unload (runtime collision against in-memory tiles only).
tiles.addEventListener('load-model', ({ scene: s }) => s.traverse(o => { if (o.isMesh) o.geometry.boundsTree = new MeshBVH(o.geometry); }));
tiles.addEventListener('dispose-model', ({ scene: s }) => s.traverse(o => { if (o.isMesh) o.geometry.boundsTree = null; }));

// ---- input ----
const keys = new Set();
addEventListener('keydown', e => keys.add(e.code));
addEventListener('keyup', e => keys.delete(e.code));
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  camera.rotation.y -= e.movementX * 0.002;
  camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - e.movementY * 0.002, -1.5, 1.5);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  tiles.setResolutionFromRenderer(camera, renderer);
});

// ---- player ----
const feet = new THREE.Vector3(0, 300, 0); // drop in from above; gravity is held until ground tiles exist
let vy = 0, grounded = false;
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
const tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();

function cast(origin, dir, far) {
  ray.set(origin, dir);
  ray.far = far;
  return ray.intersectObject(tiles.group, true)[0];
}

function step(dt) {
  // horizontal intent
  fwd.set(-Math.sin(camera.rotation.y), 0, -Math.cos(camera.rotation.y));
  right.set(fwd.z, 0, -fwd.x);
  tmp.set(0, 0, 0);
  if (keys.has('KeyW')) tmp.add(fwd);
  if (keys.has('KeyS')) tmp.sub(fwd);
  if (keys.has('KeyD')) tmp.add(right);
  if (keys.has('KeyA')) tmp.sub(right);
  if (tmp.lengthSq() > 0) {
    tmp.normalize().multiplyScalar((keys.has('ShiftLeft') ? RUN : WALK) * dt);
    // walls: one ray at waist height along the move; slide along the hit surface.
    // ponytail: single ray, no capsule shapecast. Upgrade to capsule shapecast if you clip corners.
    const waist = feet.clone().setY(feet.y + EYE * 0.6);
    const dir = tmp.clone().normalize();
    const hit = cast(waist, dir, tmp.length() + RADIUS);
    if (hit) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).setY(0).normalize();
      tmp.sub(n.multiplyScalar(tmp.dot(n)));
    }
    feet.add(tmp);
  }

  // vertical
  if (grounded && keys.has('Space')) vy = JUMP;
  vy += GRAVITY * dt;
  const ground = cast(tmp.copy(feet).setY(feet.y + 1), DOWN, 2000);
  if (!ground) { vy = 0; return; } // no tiles under us yet: hold altitude instead of falling through the earth
  const nextY = feet.y + vy * dt;
  if (nextY <= ground.point.y + 0.01 && vy <= 0) { feet.y = ground.point.y; vy = 0; grounded = true; }
  else { feet.y = nextY; grounded = false; }
}

// ---- loop ----
const hud = document.getElementById('hud');
const attribution = document.getElementById('attribution');
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  step(dt);
  camera.position.copy(feet).setY(feet.y + EYE);
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  hud.textContent = `x ${feet.x.toFixed(0)}  y ${feet.y.toFixed(0)}  z ${feet.z.toFixed(0)}  ${grounded ? 'ground' : 'air'}\nWASD move · Shift run · Space jump · click to lock mouse`;
  attribution.textContent = tiles.getAttributions().map(a => a.value).join(' · ');
});
