import '../style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { isSupported, connect, disconnect, send } from '../serial.js';
import { HardwareFX } from './hardware.js';
import { Overlay } from './overlay.js';
import { World, GRAVEYARD } from './world.js';
import { TuxedoMan } from './tuxedo.js';
import { NightSky } from './sky.js';
import { FilmShader, Cards } from './film.js';
import { Sound } from './audio.js';
import { Decor } from './decor.js';
import { ButtonGestures } from './gestures.js';
import { LookBack, BEATS } from './lookback.js';
import { Menu } from './menu.js';
import { smooth } from './noise.js';

// ───────────────────────── DOM: reuse the HUD, add title screen ─────────────────────────
const $ = (s) => document.querySelector(s);
document.title = 'The Tuxedo Man';
document.body.classList.add('tuxedo');
const hud = $('.hud');
hud.classList.add('hidden');
hud.querySelector('h1').textContent = 'The Tuxedo Man';
const rows = hud.querySelectorAll('dl dt');
['Moonlight', 'Presence', 'Flash', 'Threat', 'Act'].forEach((t, i) => rows[i] && (rows[i].textContent = t));
const ui = {
  connect: $('#connect'), status: $('#status'), mode: $('#mode'),
  lightBar: $('#light-bar'), lightVal: $('#light-val'), nearBar: $('#near-bar'), nearVal: $('#near-val'),
  btnDot: $('#btn-dot'), threat: $('#angle-val'), act: $('#swatch'), hint: $('#hint'),
};
ui.hint.textContent = 'Sim: W/S walk · Shift run · A/D look · Alt (or C) hide · Space: 1× look back, 2× flashlight, 3× call out, hold = hide · E close eyes · mouse ↕ moonlight · scroll = reach in · H panel';
ui.act.style.cssText = 'width:auto;border:0;background:none';
// title screen lives in menu.js (built after the sound system exists, below)
const cards = new Cards();

// ───────────────────────── input (hardware + sim share one shape) ─────────────────────────
const params = new URLSearchParams(location.search);
const input = { light: 0.8, near: 0, cm: null, button: false };
if (params.has('light')) input.light = +params.get('light');
if (params.has('near')) input.near = +params.get('near');
let mode = 'sim', hwReady = false;
const hwfx = new HardwareFX(send);   // NeoPixel pumpkin + twitching servo prop
const overlay = new Overlay();       // death screen + sensor check
// scares that are YOUR mistake end the run (back to the last checkpoint); scripted ones you live through
const FATAL = new Set(['caught']);   // only getting spotted while crouched ends the run; the hand lunge is a scare you survive
let deadPrevBtn = true;
const cal = { min: Infinity, max: -Infinity };
const ldr = { room: null };   // the room's normal LDR reading (eyes-switch baseline)
// Light sensor calibration: track the darkest and brightest readings, but let old extremes slowly fade
// (~1 min) so one LED flash or one deep cover doesn't stretch the range forever.
const normalize = (raw) => {
  if (!Number.isFinite(cal.min)) { cal.min = raw; cal.max = raw; }
  cal.min = raw < cal.min ? raw : cal.min + (raw - cal.min) * 0.0005;
  cal.max = raw > cal.max ? raw : cal.max + (raw - cal.max) * 0.0005;
  return THREE.MathUtils.clamp((raw - cal.min) / Math.max(cal.max - cal.min, 60), 0, 1);
};
const NEAR_CM = 10, FAR_CM = 50;
const cmToNear = (cm) => (!cm ? 0 : THREE.MathUtils.clamp(1 - (cm - NEAR_CM) / (FAR_CM - NEAR_CM), 0, 1));

// ───────────────────────── renderer / post ─────────────────────────
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2('#080b14', 0.035);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 160);
camera.rotation.order = 'YXZ';
scene.add(camera);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.6, 0.72);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const film = new ShaderPass(FilmShader);
composer.addPass(film);

let baseFov = 55;
function resize() {
  const w = innerWidth, h = innerHeight, pr = Math.min(devicePixelRatio, 1.5);
  renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h;
  // keep the same horizontal view inside the 2.39:1 letterbox
  baseFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / Math.min(camera.aspect, 2.39) * 1.15));
  camera.fov = baseFov;
  camera.updateProjectionMatrix();
  film.uniforms.uAspect.value = w / h;
}
addEventListener('resize', resize);
resize();

// ───────────────────────── lights ─────────────────────────
const moonLight = new THREE.DirectionalLight('#9fb2e0', 0.4);
scene.add(moonLight, moonLight.target);
const hemi = new THREE.HemisphereLight('#1d2846', '#0b0806', 0.3);
scene.add(hemi);
// flashlight: held a little right and below the eye, casting long tree shadows
// A real 80s flashlight: a hot centre, a faint ring from the reflector, a soft falloff (the cookie texture below),
// plus a wide, dim spill around the beam so your peripheral vision isn't pitch black.
const flashlight = new THREE.SpotLight('#fff1d6', 60, 60, 0.5, 0.35, 1.1);
flashlight.castShadow = true;
flashlight.map = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), r = 128;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, '#ffffff'); grad.addColorStop(0.22, '#f4f0e6');   // hot spot
  grad.addColorStop(0.36, '#9c968a'); grad.addColorStop(0.46, '#c9c2b4');   // dark band, then the reflector ring
  grad.addColorStop(0.55, '#6e6a62'); grad.addColorStop(0.85, '#2a2826'); grad.addColorStop(1.0, '#000000');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
})();
const spill = new THREE.SpotLight('#ffe8c4', 0, 24, 1.05, 1, 1.6);   // no shadows: cheap
spill.position.set(0.22, -0.28, 0.1);
camera.add(spill); camera.add(spill.target);
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.3;
flashlight.shadow.bias = -0.0005;
flashlight.position.set(0.22, -0.28, 0.1);
camera.add(flashlight);
flashlight.target.position.set(0.05, -0.9, -6);
camera.add(flashlight.target);
// cold key light that only exists for the jumpscare, so his face always reads (his arm can't shadow it)
const faceLight = new THREE.PointLight('#dfe8ff', 0, 3, 2);
faceLight.position.set(0.08, 0.1, 0.05);
camera.add(faceLight);

const sky = new NightSky(scene);
const world = new World(scene, renderer);
const decor = new Decor(scene, world);
const sound = new Sound();
let tux = null;

new GLTFLoader().loadAsync('/models/tuxedo_man.glb').then((g) => {
  tux = new TuxedoMan(scene, g, world);
}).catch((e) => { console.error(e); ui.status.textContent = 'Could not load The Tuxedo Man: ' + e.message; });

// ───────────────────────── story state ─────────────────────────
const ACTS = [
  { at: 0.0, title: 'I.', name: 'The Shortcut' },
  { at: 0.22, title: 'II.', name: 'Something in the Trees' },
  { at: 0.5, title: 'III.', name: "Don't Look Back" },
  { at: 0.86, title: 'IV.', name: 'The House' },
];
// ── checkpoints: every act is saved to localStorage the moment its title card appears ──
const SAVE_KEY = 'tuxedo-man:save';
const readSave = () => {
  try { const v = JSON.parse(localStorage.getItem(SAVE_KEY)); return v && Number.isInteger(v.act) && ACTS[v.act] ? v : null; } catch (e) { return null; }
};
const writeSave = (act) => { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ act, t: Date.now() })); } catch (e) {} };
const clearSave = () => { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} };
const storyThreat = (s) => smooth(s, 0.2, 0.32) * 0.22 + smooth(s, 0.5, 0.62) * 0.24 + smooth(s, 0.86, 0.97) * 0.14;
const story = {
  started: params.has('go') || params.has('at'),
  s: params.has('at') ? +params.get('at') : 0,
  act: -1, phase: 'walk', endT: 0, flicker: 0, nextFlicker: 6,
};
let flash = null;            // active camera-flash sequence
let scare = null;            // active jumpscare
let lastScareAt = -30, handHeld = 0;
// ── player actions from the button + light sensor ──
const gestures = new ButtonGestures();
const ctrl = {
  torchOff: false,                       // 2 clicks: you turned the flashlight off
  hiding: false, hideK: 0, passing: false, // hold: crouch, hold your breath
  cover: null, coverK: 0, spotted: false,  // crouching beside a trunk: you duck in behind it
  callCool: 0, callBoost: 0, answerAt: -1, // 3 clicks: "Hello?"
  simEyes: false, coverT: 0, eyesClosed: false, eyesK: 0, circA: 0, circR: 7, nextStep: 0, whispered: false, // covered sensor
};
// stereo pan of a world point relative to where you're facing: -1 hard left .. 1 hard right
const lookBack = new LookBack({
  world, sound, getTux: () => tux, startScare: (w, src) => startScare(w, src),
  canScare: (gap) => timer.getElapsed() - lastScareAt > gap,
});
const panFrom = (x, z) => Math.sin(camera.rotation.y + Math.PI - Math.atan2(x - camera.position.x, z - camera.position.z));

/**
 * JUMPSCARE. windup: silence + the flashlight dies; then BANG: his face at the lens,
 * scream, strobe, FOV punch, tape shredding; then a hard cut to black and he's gone.
 */
function startScare(windup = 0.75, source = 'hand') {
  if (scare || !tux) return;
  scare = { t: 0, windup, hit: false, cut: false, source, yaw: camera.rotation.y, pitch: camera.rotation.x };
  lastScareAt = timer.getElapsed();
  if (windup > 0) sound.duck(windup);
}
let lastFlashAt = -10;

/** nearest trunk within reach of the trail where you're standing; the cover spot is on its far side from where he'll come */
function findCover(s) {
  const here = world.path.getPointAt(Math.min(s, 1));
  const from = world.path.getPointAt(Math.min(0.99, s + 13 / world.pathLen));   // he walks down the trail toward you
  let best = null, bestD = 5.5;
  for (const tr of world.hideTrees) {
    const d = Math.hypot(tr.x - here.x, tr.z - here.z);
    if (d < bestD) { bestD = d; best = tr; }
  }
  if (!best) return null;
  let ux = best.x - from.x, uz = best.z - from.z; const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
  return { tx: best.x, tz: best.z, x: best.x + ux * 0.8, z: best.z + uz * 0.8 };
}
/** does the trunk sit between him and you? (distance from the trunk to the line of sight, in the ground plane) */
function trunkBlocks(cover, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
  const k = Math.max(0, Math.min(1, ((cover.tx - a.x) * vx + (cover.tz - a.z) * vz) / L2));
  return Math.hypot(a.x + vx * k - cover.tx, a.z + vz * k - cover.tz) < 0.55;
}

function begin(fromSave = false) {
  if (story.started) return;
  const save = fromSave && readSave();
  if (save) {
    // resume at the start of the saved act; beats and scripted events already behind you are skipped
    story.s = ACTS[save.act].at + 0.001;
    lookBack.beat = BEATS.findIndex((b) => b.at > story.s); if (lookBack.beat < 0) lookBack.beat = BEATS.length;
    if (story.s >= 0.72) story.scripted = 'done';
  }
  story.started = true;
  story.startedAt = timer.getElapsed();
  if (mode === 'hardware' && hwReady && !save) startCalibration(timer.getElapsed());
  sound.start();
  sound.menuMusic(false);           // belt and braces: no title music in the game, however we got here
}
const makeMenu = () => {
  const sv = readSave();
  return new Menu({ sound, serialOK: isSupported(), onStart: begin,
    save: sv && { label: `— ACT ${ACTS[sv.act].title.replace('.', '')}` }, onConnect: () => ui.connect.click() });
};
let menu = makeMenu();
if (story.started) menu.skip();

/** you died: hold on a black VHS screen until you press the button */
function die(t) {
  story.phase = 'dead'; story.deadAt = t; deadPrevBtn = true;
  ctrl.hiding = false; ctrl.passing = false;
  const act = Math.max(0, story.act);
  overlay.show({ tag: 'STOP ■', main: 'HE FOUND YOU', sub: `continue from act ${ACTS[act].title.replace('.', '')}`, hint: mode === 'hardware' ? 'press the button' : 'click or press space' });
}
function continueFromCheckpoint() {
  const act = Math.max(0, story.act);
  resetLoop();
  story.s = ACTS[act].at + 0.001; story.act = act;
  lookBack.beat = BEATS.findIndex((b) => b.at > story.s); if (lookBack.beat < 0) lookBack.beat = BEATS.length;
  if (story.s >= 0.72) story.scripted = 'done';
  story.phase = 'walk';
  overlay.hide();
  cards.show(ACTS[act].title + ' ' + ACTS[act].name, 'rewind', 3.5);
}

/** before Act I on real hardware: prove both sensors work in this room (and seed the light calibration) */
const CAL_STEPS = [
  { main: 'HOLD YOUR HAND OUT', sub: 'in front of the distance sensor', ok: () => input.near > 0.3 },
  { main: 'TAKE IT AWAY', sub: 'he has to be the only thing out there', ok: () => input.near === 0 },
  { main: 'COVER THE LIGHT SENSOR', sub: 'that is how you close your eyes', ok: () => ctrl.eyesClosed || (input.raw != null && ldr.room != null && input.raw < ldr.room * 0.6) },
  { main: 'UNCOVER IT', sub: 'open your eyes', ok: () => input.raw != null && ldr.room != null && input.raw > ldr.room * 0.75 },
];
let calib = null;
function startCalibration(t) {
  story.phase = 'calib'; calib = { step: 0, t0: t, okT: 0 }; deadPrevBtn = true;
  const S = CAL_STEPS[0];
  overlay.show({ tag: 'SENSOR CHECK', main: S.main, sub: S.sub, black: false });
}
function updateCalibration(t, dt) {
  const S = CAL_STEPS[calib.step];
  calib.okT = S.ok() ? calib.okT + dt : 0;
  if (t - calib.t0 > 8) overlay.hint('stuck? press the button to skip');
  const skip = input.button && !deadPrevBtn;
  if (calib.okT > 0.5 || skip) {
    calib.step++; calib.t0 = t; calib.okT = 0;
    if (calib.step >= CAL_STEPS.length) { calib = null; overlay.hide(); story.phase = 'walk'; story.startedAt = t; return; }
    const N = CAL_STEPS[calib.step];
    overlay.show({ tag: 'SENSOR CHECK', main: N.main, sub: N.sub, black: false });
  }
}

/** after the ending: reset the whole night and put the title screen back up */
function returnToMenu() {
  clearSave();                         // you finished the night: nothing to load
  resetLoop();
  story.started = false; story.pendingCard = undefined;
  cards.hide(); overlay.hide(); calib = null;
  Object.assign(menuScene, { shot: -1, t: 0, step: 0, placed: false, wasMenu: true, aimOff: null });
  sound.gameStarted = false;           // the title music is allowed again
  menu = makeMenu();                   // fresh title screen (LOAD GAME is gone: the save was spent at the end)
  setMode(mode, mode === 'hardware' ? 'Arduino connected — he is listening' : '');
}

function resetLoop() {
  Object.assign(ctrl, { torchOff: false, hiding: false, hideK: 0, passing: false, cover: null, coverK: 0, spotted: false, callBoost: 0, answerAt: -1, eyesClosed: false, eyesK: 0, coverT: 0 });
  gestures.reset(); lookBack.reset();
  scare = null; film.uniforms.uGlitch.value = 0; story.scripted = null;
  story.s = 0; story.phase = 'walk'; story.endT = 0; story.act = -1;
  world.setWindowLit(true);
  world.doorPivot.rotation.y = 0;
  tux?.vanish(0);
  film.uniforms.uFade.value = 0;
}

// ───────────────────────── sim input ─────────────────────────
canvas.addEventListener('pointermove', (e) => { if (mode === 'sim' && !params.has('light')) input.light = 1 - e.clientY / innerHeight; });
canvas.addEventListener('pointerdown', () => { if (!story.started) return; if (mode === 'sim') input.button = true; });
addEventListener('pointerup', () => { if (mode === 'sim') input.button = false; });
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'sim') return;
  input.cm = THREE.MathUtils.clamp((input.cm ?? FAR_CM) + e.deltaY * 0.05, NEAR_CM, FAR_CM + 10);
  input.near = cmToNear(input.cm);
  e.preventDefault();
}, { passive: false });
const keys = new Set();
const autoWalk = params.has('auto');            // ?auto = old hands-free walk in the sim
addEventListener('blur', () => keys.clear());
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code.startsWith('Alt')) e.preventDefault();      // don't let Alt focus the browser menu
  if (e.code === 'Space') { if (story.started && mode === 'sim') input.button = true; e.preventDefault(); }
  if (e.code === 'KeyH') hud.classList.toggle('hidden');
  if (e.code === 'KeyE') ctrl.simEyes = true;
  if (e.code === 'KeyR') { cal.min = Infinity; cal.max = -Infinity; }
});
addEventListener('keyup', (e) => { keys.delete(e.code); if (e.code === 'Space' && mode === 'sim') input.button = false; if (e.code === 'KeyE') ctrl.simEyes = false; });

// ───────────────────────── hardware ─────────────────────────
function setMode(next, status) {
  mode = next;
  ui.mode.textContent = next === 'hardware' ? 'LIVE' : 'SIM';
  ui.mode.classList.toggle('live', next === 'hardware');
  ui.connect.textContent = next === 'hardware' ? 'Disconnect' : 'Connect device';
  ui.status.textContent = status;
  menuStatus(status);
}
function menuStatus(text) {
  if (menu.done) return;
  menu.status(text);
  menu.setConnected(mode === 'hardware');
}
if (!isSupported()) { ui.connect.disabled = true; ui.status.textContent = 'Web Serial needs Chrome or Edge — running simulated'; }
ui.connect.addEventListener('click', async () => {
  if (mode === 'hardware') return disconnect();
  try {
    ui.status.textContent = 'Opening port…';
    await connect({
      onData: ({ raw, button, cm }) => {
        // the LDR is now just the eyes switch: the moon stays put, covering the sensor closes your eyes
        input.raw = raw;
        input.light = 0.65;
        input.button = button;
        if (cm !== null) { input.cm = cm; input.near = cmToNear(cm); }
      },
      onReady: () => { hwReady = true; hwfx.setEnabled(true); ui.status.textContent = 'Connected — he is listening'; menuStatus('Arduino connected — he is listening'); },
      onClose: () => { hwReady = false; hwfx.setEnabled(false); input.button = false; input.near = 0; input.cm = null; setMode('sim', 'Disconnected — back to simulated'); },
    });
    cal.min = Infinity; cal.max = -Infinity;
    setMode('hardware', 'Waiting for board…');
  } catch (err) {
    setMode('sim', err.name === 'NotFoundError' ? 'Simulated input' : err.message);
  }
});

// ───────────────────────── loop ─────────────────────────
let light = input.light, presence = input.near, wasPressed = false;
let stepPhase = 0, lastStep = 0, glance = 0, viewYaw = 0, freeLook = 0, aimUp = 0;
let yawMenu = 0, barsK = 0, menuK = 1;
// ── title-screen b-roll: a reel of slow shots around the woods, cut with tape glitches ──
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const nearestPumpkin = (sAt) => {
  const p = world.path.getPointAt(sAt);
  return world.pumpkins.reduce((b, q) => (q.group.position.distanceToSquared(p) < b.group.position.distanceToSquared(p) ? q : b));
};
const SHOTS = {
  // the hero tableau: him on the trail, skipping closer (camera = the normal trailhead view)
  hero: { dur: 13, hero: true },
  // a low lateral dolly past a jack-o'-lantern that turns to watch the lens
  pumpkins: {
    dur: 8,
    setup() { this.p = nearestPumpkin(0.26); this.p.stare = true; world.stareT = 12; },
    cam(k) {
      const c = this.p.group.position, tg = world.path.getTangentAt(0.26);
      const side = V3(-tg.z, 0, tg.x);
      return { pos: c.clone().addScaledVector(side, 3.4).addScaledVector(tg, THREE.MathUtils.lerp(-1.8, 1.8, k)).add(V3(0, 0.9, 0)), look: c.clone().add(V3(0, 0.2, 0)), subject: c, soft: true };
    },
  },
  // looking up at a hanging sheet ghost, slowly orbiting it
  ghost: {
    dur: 8,
    setup() { this.g = decor.ghosts[1] || decor.ghosts[0]; },
    cam(k) {
      const b = this.g.pivot.position.clone().add(V3(0, -1.6, 0)), a = this.g.yaw + Math.PI + THREE.MathUtils.lerp(-0.35, 0.35, k);
      const pos = V3(b.x + Math.sin(a) * 2.6, 0, b.z + Math.cos(a) * 2.6); pos.y = world.height(pos.x, pos.z) + 0.9;
      return { pos, look: b, subject: b };
    },
  },
  // a slow push toward the graveyard... and halfway through he's standing at the back
  graveyard: {
    dur: 9,
    setup() { this.shown = false; },
    cam(k) {
      const { x, z, d } = GRAVEYARD, h = world.height(x, z);
      const c = V3(x, h + 0.7, z);
      if (!this.shown && k > 0.5 && tux) {
        this.shown = true; menuScene.glitch = 0.8;
        tux.pos.set(x + 1.6, 0, z - d / 2 - 1.2); tux.pos.y = world.height(tux.pos.x, tux.pos.z);
        tux.root.position.copy(tux.pos); tux.mode = 'staged'; tux.stagedTilt = true; tux.root.visible = true;
      }
      return { pos: V3(x - 1.5, h + 1.3, z + d / 2 + THREE.MathUtils.lerp(8.5, 5.5, k)), look: c, subject: this.shown ? tux.pos.clone().add(V3(0, 1.6, 0)) : c };
    },
  },
  // the house at the end of the trail, door ajar... and he's in the doorway
  house: {
    dur: 10,
    setup() { this.shown = false; world.doorPivot.rotation.y = -0.7; },
    cam(k) {
      const H = world.house;
      if (!this.shown && k > 0.55 && tux) { this.shown = true; menuScene.glitch = 0.8; tux.standInDoorway(); tux.mode = 'staged'; tux.stagedTilt = true; }
      return { pos: H.localToWorld(V3(-1.2, 1.7, THREE.MathUtils.lerp(17, 12, k))), look: H.localToWorld(V3(0, 2.0, 0)), subject: world.doorway };
    },
  },
  // a slow push in on the scarecrow
  scarecrow: {
    dur: 7,
    cam(k) {
      const sc = world.scarecrow, c = sc.position.clone().add(V3(0, 2.1, 0));
      const f = V3(Math.sin(sc.rotation.y), 0, Math.cos(sc.rotation.y));
      return { pos: c.clone().addScaledVector(f, THREE.MathUtils.lerp(4.2, 2.4, k)).add(V3(0.6, -0.5, 0)), look: c, subject: c };
    },
  },
};
const REEL = ['hero', 'pumpkins', 'ghost', 'graveyard', 'hero', 'house', 'scarecrow'];
const menuScene = { shot: -1, t: 0, step: 0, next: 4, glitch: 0, placed: false, wasMenu: true, aimOff: null };
const redLight = new THREE.PointLight('#ff2414', 0, 9, 1.6);
const rimLow = new THREE.PointLight('#ff3a1c', 0, 6, 1.6);   // second rim, low behind his legs
scene.add(redLight, rimLow);
const fogNight = new THREE.Color('#080b14'), fogMenu = new THREE.Color('#1c0606');

function rimBehind(subject, camPos, hi = 22, lo = 10) {
  const back = V3(subject.x - camPos.x, 0, subject.z - camPos.z).normalize(), side = V3(-back.z, 0, back.x);
  redLight.position.copy(subject).addScaledVector(back, 0.9).addScaledVector(side, 0.5).setY(subject.y + 0.6);
  rimLow.position.copy(subject).addScaledVector(back, 0.8).addScaledVector(side, -0.6).setY(subject.y - 1.0);
  redLight.userData.k = hi; rimLow.userData.k = lo;
}

function updateMenuScene(dt, t) {
  const M = menuScene, inMenu = !story.started;
  barsK += ((inMenu ? 0 : 1) - barsK) * (1 - Math.exp(-dt * 1.2));
  menuK += ((inMenu ? 1 : 0) - menuK) * (1 - Math.exp(-dt * 1.1));
  film.uniforms.uBars.value = barsK;
  film.uniforms.uMenu.value = menuK;
  scene.fog.color.lerpColors(fogNight, fogMenu, menuK);
  redLight.intensity = (redLight.userData.k ?? 22) * menuK * (0.9 + Math.random() * 0.15);
  rimLow.intensity = (rimLow.userData.k ?? 10) * menuK * (0.9 + Math.random() * 0.15);
  if (!inMenu) {
    if (M.wasMenu) { M.wasMenu = false; tux?.vanish(0); world.doorPivot.rotation.y = 0; film.uniforms.uFade.value = 0; }
    return;
  }
  if (!tux) return;
  scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, 0.045, 0.6);
  M.glitch = Math.max(0, M.glitch - dt * 4);

  // next shot in the reel
  M.t += dt;
  const cur = SHOTS[REEL[M.shot]];
  if (M.shot < 0 || M.t > cur.dur) {
    M.shot = (M.shot + 1) % REEL.length; M.t = 0;
    const S = SHOTS[REEL[M.shot]];
    tux.vanish(0); world.doorPivot.rotation.y = 0;
    S.setup?.();
    M.step = 0; M.next = 3.5; M.placed = false;
    if (M.shot !== 0) { M.glitch = 0.9; }
  }
  const S = SHOTS[REEL[M.shot]];
  // dip to black at both ends of every shot
  film.uniforms.uFade.value = 1 - smooth(M.t, 0, 0.7) * (1 - smooth(M.t, S.dur - 0.5, S.dur));

  if (S.hero) {
    M.next -= dt;
    if (M.next <= 0 && M.step < 3) { M.step++; M.next = 3.2; M.placed = false; M.glitch = 1; }
    if (!M.placed) {
      M.placed = true;
      const d = 5.5 - M.step * 0.95;
      tux.standOnPath(Math.min(0.2, story.s + d / world.pathLen), 0.25);
      if (M.aimOff === null) {
        const a = Math.atan2(-(tux.pos.x - camera.position.x), -(tux.pos.z - camera.position.z));
        M.aimOff = Math.atan2(Math.sin(a - viewYaw - 0.3), Math.cos(a - viewYaw - 0.3));
      }
      tux.mode = 'staged'; tux.stagedTilt = M.step >= 1; tux.root.visible = true;
      rimBehind(tux.pos.clone().add(V3(0, 1.4, 0)), camera.position);
    }
    const h = tux.pos.clone().add(V3(0, 1.6, 0));
    flashlight.target.position.copy(camera.worldToLocal(h));
    flashlight.intensity = 26 + Math.random() * 3;
  } else {
    // b-roll: take the camera over completely
    const k = M.t / S.dur, { pos, look, subject, soft } = S.cam(k);
    pos.y = Math.max(pos.y, world.height(pos.x, pos.z) + 0.5);         // never under the ground
    camera.position.copy(pos);
    camera.lookAt(look);
    camera.rotateZ(Math.sin(t * 0.4) * 0.01);                         // handheld drift
    camera.updateMatrixWorld();
    moonLight.position.copy(camera.position).add(tmp.set(8, 18, -30)); moonLight.target.position.copy(camera.position);
    rimBehind(subject, camera.position, soft ? 0 : 12, soft ? 0 : 5);
    flashlight.target.position.copy(camera.worldToLocal(look.clone()));
    flashlight.intensity = soft ? 0 : 5;
  }
  film.uniforms.uGlitch.value = M.glitch * 0.5;     // shot cuts: a short, light tape skip
}
const timer = new THREE.Timer();
const tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), look = new THREE.Vector3();
const doorLook = () => world.house.localToWorld(new THREE.Vector3(0, 1.7, 3.5));

function tick() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const t = timer.getElapsed();

  // smoothing: moonlight drifts, presence reacts fast
  light += (input.light - light) * (1 - Math.exp(-dt * 2));
  presence += (input.near - presence) * (1 - Math.exp(-dt * 6));

  // ── scripted flashlight sputters in Act III and IV: forced "blinks" ──
  if (story.started && story.phase === 'walk' && story.s > 0.5) {
    story.nextFlicker -= dt;
    if (story.nextFlicker <= 0) { story.flicker = 0.7; story.nextFlicker = 5 + Math.random() * 6; }
  }
  story.flicker = Math.max(0, story.flicker - dt);
  const sputter = story.flicker > 0 ? (Math.sin(t * 60) > 0.2 || story.flicker < 0.45 ? 1 : 0) : 0;
  const lowBatt = light < 0.35 ? (Math.random() < 0.08 * (1 - light / 0.35) ? 1 : 0) : 0;
  let dark = Math.max(1 - light, sputter, lowBatt);

  // ── eyes: cover the light sensor completely (or hold E) and you shut them ──
  const walking = story.started && story.phase === 'walk';
  // Eyes = a big drop from the room's normal LDR reading. 'room' slowly follows the reading only while uncovered,
  // so it adapts to the lab's lighting but never learns your hand as normal.
  // Close below 60% of the room level, reopen above 75% (the gap stops fluttering at the edge).
  let covered = ctrl.simEyes;
  if (mode === 'hardware' && input.raw != null) {
    if (ldr.room == null) ldr.room = input.raw;
    covered = covered || input.raw < ldr.room * (ctrl.eyesClosed ? 0.75 : 0.6);
    if (!covered && !ctrl.eyesClosed) ldr.room += (input.raw - ldr.room) * (1 - Math.exp(-dt / 3));
  }
  ctrl.coverT = covered ? ctrl.coverT + dt : 0;
  const shut = walking && !scare && ctrl.coverT > 0.25;
  if (shut && !ctrl.eyesClosed) {                       // just closed
    ctrl.eyesClosed = true; ctrl.whispered = false;
    ctrl.circA = tux?.root.visible ? Math.atan2(tux.pos.x - camera.position.x, tux.pos.z - camera.position.z) : Math.random() * 6.28;
    ctrl.circR = 7; ctrl.nextStep = t + 0.6;
  } else if (!shut && ctrl.eyesClosed) {                // just opened: he is wherever he stopped
    ctrl.eyesClosed = false;
    if (tux?.mode === 'circling') {
      tux.noticeYou(story.s);
      const rel = Math.atan2(Math.sin(ctrl.circA - camera.rotation.y - Math.PI), Math.cos(ctrl.circA - camera.rotation.y - Math.PI));
      if (ctrl.circR < 2.8 && Math.abs(rel) < 1.0 && t - lastScareAt > 6) startScare(0, 'eyes');
    }
  }
  ctrl.eyesK += ((ctrl.eyesClosed ? 1 : 0) - ctrl.eyesK) * (1 - Math.exp(-dt * (ctrl.eyesClosed ? 14 : 7)));
  if (ctrl.torchOff) dark = Math.max(dark, 0.9);

  // ── Act III: the flashlight dies for a long beat... and when it comes back he's there ──
  if (story.started && story.phase === 'walk' && !scare) {
    if (!story.scripted && story.s >= 0.72) { story.scripted = 'armed'; story.flicker = 1.4; story.nextFlicker = 9; sound.duck(1.4); }
    else if (story.scripted === 'armed' && story.flicker <= 0.02 && !ctrl.eyesClosed && !ctrl.hiding) { story.scripted = 'done'; startScare(0, 'act'); }
  }
  // ── hand held right up to the sensor for a moment = he lunges ──
  handHeld = presence >= 0.9 ? handHeld + dt : 0;    // hand held at 90%+ presence (~14 cm or closer to the laser)
  if (story.started && story.phase === 'walk' && handHeld > 5 && !scare && !lookBack.active && !ctrl.eyesClosed && !ctrl.hiding && t - lastScareAt > 12 && story.s > 0.08) startScare(0.7, 'hand');

  // ── scare timeline ──
  let scareDark = 0, scareShake = 0, fovK = 1;
  if (scare) {
    scare.t += dt;
    const k = scare.t - scare.windup;                         // time since impact
    if (k < 0) scareDark = 1;                                  // flashlight dead during the windup
    if (!scare.hit && k >= 0) {
      scare.hit = true;
      scare.yaw = camera.rotation.y; scare.pitch = camera.rotation.x;   // freeze whatever you were looking at
      tux.scareAt(camera, 0.62);
      sound.scream();
      if (scare.source === 'end') sound.snarl(1, 1.8);                 // the door: he SNARLS in your face
      film.uniforms.uFlash.value = Math.max(film.uniforms.uFlash.value, 0.55);
    }
    if (scare.hit) {
      // alternate clean frames (you SEE him) with shredded ones; the first beat is almost clean
      film.uniforms.uGlitch.value = k < 0.9 ? (k < 0.12 ? 0.12 : (Math.floor(k * 20) % 3 === 0 ? 1 : 0.2)) * (1 - k * 0.3) : 0;
      film.uniforms.uFade.value = k < 0.55 ? (Math.floor(k * 22) % 3 === 2 ? 0.85 : 0) : 0;   // strobe
      scareShake = k < 0.9 ? 0.05 * (1 - k) : 0;
      fovK = 0.68 + 0.32 * smooth(k, 0, 0.7);                 // punch in on his face
      if (!scare.cut && k >= 0.9) { scare.cut = true; tux.vanish(10); sound.hit(); }
      if (scare.cut) {
        film.uniforms.uFade.value = story.phase === 'end' ? 1 : (k < 1.3 ? 1 : 1 - smooth(k, 1.3, 1.9));
        film.uniforms.uGlitch.value = k < 1.3 ? 0 : 0.4 * (1 - smooth(k, 1.3, 2.2));
      }
      if (k > 2.2) {
        const fatal = FATAL.has(scare.source) && story.phase === 'walk';
        scare = null; film.uniforms.uGlitch.value = 0; if (story.phase !== 'end') film.uniforms.uFade.value = 0;
        if (fatal) die(t);
      }
    }
  }
  const scareFrozen = scare && scare.hit && !scare.cut;

  dark = Math.max(dark, scareDark);
  // ── death screen / sensor check: wait for the player ──
  if (story.phase === 'dead' && t - story.deadAt > 1.2 && input.button && !deadPrevBtn) continueFromCheckpoint();
  if (story.phase === 'calib') updateCalibration(t, dt);
  deadPrevBtn = input.button;
  // ── story progression ──
  const threat = Math.min(1, Math.max(storyThreat(story.s), presence * 0.95) + ctrl.callBoost + (ctrl.running ? 0.08 : 0) + (story.phase === 'end' ? 0.3 : 0));
  if (story.started && story.phase === 'walk') {
    const manual = mode === 'sim' && !autoWalk;
    const move = manual ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 0.55 : 0) : 1;   // S = back up slowly
    ctrl.running = move > 0 && (keys.has('ShiftLeft') || keys.has('ShiftRight')) && !ctrl.hiding && !ctrl.eyesClosed;   // no running blind
    const speed = move * (ctrl.running ? 2.1 : 1) * 0.95 * (0.55 + 0.45 * light) * (lookBack.active ? 0.3 : 1) * (scare || ctrl.hiding ? 0 : ctrl.eyesClosed ? 0.45 : 1) * (ctrl.torchOff ? 0.5 : 1) * (1 - ctrl.hideK);            // he slows down in the dark
    story.s = THREE.MathUtils.clamp(story.s + (speed * dt) / world.pathLen, 0, 1);
    ctrl.blindWalk = ctrl.eyesClosed && speed > 0.05;            // shuffling forward with your eyes shut
    stepPhase += Math.abs(speed) * dt * 1.8;
    const act = ACTS.reduce((a, A, i) => (story.s >= A.at ? i : a), 0);
    if (act !== story.act) {
      story.act = act;
      story.pendingCard = act;                                         // shown below, once the screen is clear
      writeSave(act);                                                  // checkpoint
    }
    if (story.s >= 1) { story.phase = 'end'; story.endT = 0; }
    // act title cards wait until the fade-in from the menu has cleared (~2.5 s after starting)
    if (story.pendingCard !== undefined && t - (story.startedAt ?? -99) > 2.6) {
      const a = story.pendingCard; story.pendingCard = undefined;
      if (a === 0) cards.show('October 31, 1986', 'Hollow Road  ·  11:47 PM', 6);
      else cards.show(ACTS[a].title + ' ' + ACTS[a].name, 'checkpoint', 4);
    }
  }

  // ── the ending: window goes dark, door creaks, he is waiting inside ──
  if (story.phase === 'end') {
    const e0 = story.endT; story.endT += dt; const e = story.endT;
    const at = (x) => e0 < x && e >= x;
    if (at(0.1)) tux?.vanish(0);
    if (at(2.2)) { world.setWindowLit(false); sound.hit(); }
    if (at(4.0)) sound.creak();
    if (e > 4.0) world.doorPivot.rotation.y = -1.35 * smooth(e, 4.0, 7.5);
    if (at(6.5)) { tux?.standInDoorway(); sound.snarl(0.3, 2.2); }     // a low growl from inside the house
    if (at(8.3)) startScare(0.7, 'end');
    if (e > 10.2 && !scare) film.uniforms.uFade.value = 1;
    if (at(10.2)) { cards.show('Happy Halloween', '', 5); clearSave(); }   // you finished it: the save is spent
    if (at(16)) returnToMenu();                                      // the night is over: back to the title screen
  }

  // ── button gestures ──
  const ev = walking ? gestures.update(input.button, t) : (gestures.reset(), null);
  wasPressed = input.button;
  const busy = scare || ctrl.eyesClosed;
  if (ev?.type === 'clicks' && !busy && !ctrl.hiding) {
    if (ev.n === 1 && !lookBack.active) {                               // 1×: look back over your shoulder
      lookBack.start(t, story.s, camera);
    } else if (ev.n === 2) {                                             // 2×: flashlight off / on
      ctrl.torchOff = !ctrl.torchOff; sound.click();
      if (!ctrl.torchOff && tux?.root.visible && tux.distance < 7 && threat > 0.25 && t - lastScareAt > 6) startScare(0, 'torch');   // ...he was right there
    } else if (ev.n === 3 && ctrl.callCool <= 0) {                       // 3×: "Hello?"
      sound.callOut(); world.alert = 1;
      ctrl.callCool = 8; ctrl.callBoost = 0.28; ctrl.answerAt = t + 1.8 + Math.random() * 1.2;
    }
  }
  if (ev?.type === 'holdStart') ctrl.holdBtn = true;
  if (ev?.type === 'holdEnd') ctrl.holdBtn = false;
  const wantHide = walking && (ctrl.holdBtn || keys.has('AltLeft') || keys.has('AltRight') || keys.has('KeyC'));
  if (wantHide && !ctrl.hiding && !busy && !lookBack.active) {          // hold: hide
    ctrl.hiding = true; ctrl.spotted = false;
    ctrl.cover = findCover(story.s);
    if (tux && threat > 0.12 && tux.mode !== 'doorway') { tux.startPass(story.s); ctrl.passing = true; }
  }
  if (!wantHide && ctrl.hiding) {
    ctrl.hiding = false;
    if (ctrl.passing && tux?.mode === 'passing') {                      // stood up too soon
      tux.noticeYou(story.s); ctrl.callBoost = Math.max(ctrl.callBoost, 0.2);
      if (tux.distance < 5.5 && t - lastScareAt > 4) startScare(0.35, 'caught');
    }
    ctrl.passing = false;
  }
  // while he walks past: behind a trunk you're safe; out in the open he sees you, unless your flashlight is off
  if (ctrl.passing && tux?.mode === 'passing' && !ctrl.spotted && !scare && tux.distance < 4.5 && tux.passS > story.s + 1.5 / world.pathLen) {   // only while he's still coming toward you; once past, he faces away
    const hidden = (ctrl.cover && ctrl.coverK > 0.6 && trunkBlocks(ctrl.cover, tux.pos, camera.position)) || ctrl.torchOff;
    if (!hidden) {
      ctrl.spotted = true;
      tux.noticeYou(story.s); ctrl.callBoost = Math.max(ctrl.callBoost, 0.25);
      if (t - lastScareAt > 4) startScare(0.35, 'caught');
    }
  }
  ctrl.coverK += ((ctrl.hiding && ctrl.cover ? 1 : 0) - ctrl.coverK) * (1 - Math.exp(-dt * 3));
  if (!ctrl.hiding && ctrl.coverK < 0.02) ctrl.cover = null;
  if (ctrl.passing && tux?.passDone) { tux.vanish(12); ctrl.passing = false; }   // you made it
  ctrl.hideK += ((ctrl.hiding ? 1 : 0) - ctrl.hideK) * (1 - Math.exp(-dt * 5));
  // the answer to your call: knocking out in the dark, and he moves in
  ctrl.callCool = Math.max(0, ctrl.callCool - dt);
  ctrl.callBoost = Math.max(0, ctrl.callBoost - dt * 0.015);
  if (ctrl.answerAt > 0 && t >= ctrl.answerAt) {
    ctrl.answerAt = -1;
    const a = camera.rotation.y + Math.PI + (Math.random() - 0.5) * 3;   // somewhere around you
    sound.knock(Math.sin(a - camera.rotation.y - Math.PI));
    if (tux && !scare && tux.mode !== 'doorway' && !ctrl.passing) { tux.relocate(story.s, 9); tux.mode = 'lurking'; }
  }
  // eyes shut: footsteps circle you, getting closer
  if (ctrl.eyesClosed && tux && threat > 0.1) {
    ctrl.circA += dt * 0.8;
    // standing still with your eyes shut: he circles but keeps his distance (3.4 m, outside grabbing range).
    // walking blind: he closes in (to 2.2 m), and if you stop he drifts back out.
    if (ctrl.blindWalk) ctrl.circR = Math.max(2.2, ctrl.circR - dt * 0.5);
    else ctrl.circR = ctrl.circR > 3.4 ? Math.max(3.4, ctrl.circR - dt * 0.45) : Math.min(3.4, ctrl.circR + dt * 0.3);
    tux.circle(camera, ctrl.circA, ctrl.circR);
    if (t > ctrl.nextStep) { sound.stepAt(panFrom(tux.pos.x, tux.pos.z), 1 - ctrl.circR / 7); ctrl.nextStep = t + 0.5 + Math.random() * 0.25; }
    if (!ctrl.whispered && ctrl.circR < 2.6) { ctrl.whispered = true; sound.whisper(panFrom(tux.pos.x, tux.pos.z)); }
  }
  // ── looking back: the suspense ladder (lookback.js) ──
  const flashYaw = walking || lookBack.active
    ? lookBack.update(dt, t, { s: story.s, camera, paused: !!scare, blocked: !!scare || ctrl.hiding || ctrl.eyesClosed })
    : 0;
  film.uniforms.uFlash.value *= Math.exp(-dt * (story.phase === 'end' ? 2 : 7));

  // ── first-person camera on the trail ──
  const s = story.s;
  if (story.phase === 'walk' || story.endT < 1) {
    const p = world.path.getPointAt(Math.min(s, 1));
    const ahead = world.path.getPointAt(Math.min(1, s + 5 / world.pathLen));
    viewYaw = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z));
    const bob = Math.abs(Math.sin(stepPhase * Math.PI)) * (ctrl.running ? 0.09 : 0.05) * (1 + ctrl.eyesK * 0.8);   // eyes shut: an unsteady shuffle
    // crouched by a tree: slide in behind the trunk (away from where he'll come down the trail)
    const cx = ctrl.cover ? THREE.MathUtils.lerp(p.x, ctrl.cover.x, ctrl.coverK) : p.x;
    const cz = ctrl.cover ? THREE.MathUtils.lerp(p.z, ctrl.cover.z, ctrl.coverK) : p.z;
    camera.position.set(cx, world.height(cx, cz) + 1.66 + bob - ctrl.hideK * 0.75, cz);
    // footsteps on each half step
    if (story.phase === 'walk' && Math.floor(stepPhase) !== lastStep) { lastStep = Math.floor(stepPhase); sound.footstep(); }
  }
  // nervous glance toward him when he's visible off to the side
  let wantGlance = 0;
  if (tux?.root.visible && (tux.mode === 'lurking' || tux.mode === 'passing') && (threat > 0.3 || tux.mode === 'passing')) {
    const a = Math.atan2(-(tux.pos.x - camera.position.x), -(tux.pos.z - camera.position.z));
    const d = Math.atan2(Math.sin(a - viewYaw), Math.cos(a - viewYaw));
    if (Math.abs(d) < 1.2) wantGlance = d * 0.35;
  }
  glance += (wantGlance - glance) * (1 - Math.exp(-dt * 0.8));
  // handheld shake grows with presence
  const shake = 0.004 + presence * 0.012 + (story.phase === 'end' ? 0.006 : 0) + ctrl.hideK * 0.006 + (ctrl.running ? 0.01 : 0);
  const jx = (Math.sin(t * 1.7) + Math.sin(t * 3.9) * 0.5) * shake, jy = (Math.sin(t * 2.3) + Math.sin(t * 5.1) * 0.4) * shake;
  if (!story.started) yawMenu = Math.sin(t * 0.09) * 0.035 + Math.sin(t * 0.031) * 0.02;   // the menu shot barely breathes
  const wantLook = lookBack.active || scare ? 0 : ((keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0)) * 1.1;
  freeLook += (wantLook - freeLook) * (1 - Math.exp(-dt * 4));
  let yaw = viewYaw + glance + flashYaw + freeLook + (story.started ? 0 : yawMenu + (menuScene.aimOff ?? 0) * menuK) + jx, pitch = -0.04 - ctrl.hideK * 0.06 + jy - Math.abs(Math.sin(stepPhase * Math.PI)) * 0.01;
  if (story.phase === 'end') {
    const d = doorLook();
    const dy = Math.atan2(-(d.x - camera.position.x), -(d.z - camera.position.z));
    const k = smooth(story.endT, 0, 2);
    yaw = THREE.MathUtils.lerp(viewYaw, dy, k) + jx;
    pitch = THREE.MathUtils.lerp(-0.04, Math.atan2(d.y - camera.position.y, Math.hypot(d.x - camera.position.x, d.z - camera.position.z)), k) + jy;
    if (story.endT > 6.5) camera.position.lerp(world.porchSpot.clone().setY(camera.position.y), dt * 0.15);   // slow push-in
  }
  if (scare && scare.hit && !scare.cut) {
    yaw = scare.yaw + (Math.random() - 0.5) * scareShake;
    pitch = scare.pitch + (Math.random() - 0.5) * scareShake;
  }
  camera.rotation.set(pitch, yaw, Math.sin(stepPhase * Math.PI) * 0.008 + (Math.random() - 0.5) * scareShake * 0.6);
  if (Math.abs(camera.fov - baseFov * fovK) > 0.01) { camera.fov = baseFov * fovK; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();

  // ── lights from the light sensor ──
  const moonK = 0.06 + 0.5 * light;
  moonLight.intensity = moonK;
  moonLight.position.copy(camera.position).add(tmp.set(8, 18, -30));
  moonLight.target.position.copy(camera.position);
  hemi.intensity = 0.12 + 0.25 * light;
  flashlight.intensity = (1 - Math.max(sputter, lowBatt, scareDark)) * (55 + 60 * light) * (0.95 + Math.sin(t * 17) * 0.03) * (ctrl.torchOff ? 0 : 1) * (1 - ctrl.hideK * 0.88);
  faceLight.intensity = scareFrozen ? 0.32 + Math.random() * 0.2 : 0;
  if (scareFrozen) { flashlight.intensity = 1.4 + Math.random() * 0.8; flashlight.target.position.set(-0.22, 0.32, -0.62); }
  else {
    // when you turn around you raise the flashlight into the trees
    aimUp += ((lookBack.active ? 1 : 0) - aimUp) * (1 - Math.exp(-dt * 5));
    flashlight.target.position.set(0.05, THREE.MathUtils.lerp(-0.9, -0.12, aimUp), THREE.MathUtils.lerp(-6, -12, aimUp));
    flashlight.distance = 60 + aimUp * 20;
  }
  scene.fog.density = (0.03 + (1 - light) * 0.018) * (1 - 0.3 * aimUp);   // looking back: your eyes strain into the dark, the beam reaches further

  updateMenuScene(dt, t);

  // ── The Tuxedo Man ──
  let interference = 0;
  if (tux && (story.started || menuScene.wasMenu)) {
    tux.update(dt, t, { s, threat, dark: story.phase === 'end' ? 0 : dark, presence, camera });
    // static = him: on screen it builds from 22 m in; off screen only when he's right behind / beside you
    if (tux.root.visible) interference = tux.isOnScreen(camera) ? smooth(tux.distance, 22, 3.5) : smooth(tux.distance, 8, 2.5) * 0.6;
    // eyes shut: the static is your only sense of where he is. Loud = he's in front of you (don't open). Fading = he's behind.
    if (ctrl.eyesClosed && tux.mode === 'circling') {
      const rel = Math.atan2(Math.sin(ctrl.circA - camera.rotation.y - Math.PI), Math.cos(ctrl.circA - camera.rotation.y - Math.PI));
      const front = Math.min(1, Math.max(0, (Math.cos(rel) - 0.3) / 0.5));
      interference = 0.06 + smooth(ctrl.circR, 7, 2.5) * front;
    }
  }
  film.uniforms.uInterference.value = scareFrozen ? 0.3 : interference * (story.started ? 1 : 0.3);
  film.uniforms.uRed.value = smooth(threat, 0.75, 1) * (tux?.root.visible ? 1 : 0.3);
  film.uniforms.uTime.value = t;
  film.uniforms.uEyes.value = ctrl.eyesK;

  world.update(dt, t, presence, camera, threat);
  decor.update(dt, t, presence, camera, story.s);
  sky.update(t, camera, 1 - light);
  sound.update(dt, { threat, interference: story.started ? interference : 0, menu: !story.started, dark, silence: story.phase === 'end' && story.endT > 10, hiding: ctrl.hideK, blind: ctrl.eyesK });

  hwfx.update(t, { playing: story.started, threat, presence, hideK: ctrl.hideK, eyesK: ctrl.eyesK, torchOff: ctrl.torchOff, ending: story.phase === 'end' && story.endT > 10, scare, tux });

  // spill follows the beam; a small hand sway so it feels held, not mounted
  if (!scareFrozen && story.started) {
    flashlight.target.position.x += Math.sin(t * 1.3) * 0.05 + Math.sin(t * 3.1) * 0.02;
    flashlight.target.position.y += Math.sin(t * 1.7 + 1) * 0.04;
  }
  // looking back: your hand swings the beam onto whatever shape is standing there (him, or a fake-out scarecrow)
  const caught = lookBack.active && aimUp > 0.05 && !scareFrozen
    ? (tux?.root.visible && tux.mode === 'staged' ? tux.root : lookBack.look?.fake && lookBack.fake?.visible ? lookBack.fake : null) : null;
  if (caught) {
    const h = caught.position.clone(); h.y += 1.3;
    camera.updateMatrixWorld();
    flashlight.target.position.lerp(camera.worldToLocal(h), 0.9 * aimUp);
    flashlight.intensity *= 1 + 0.7 * aimUp;                     // you hold it steady on him: the beam lands full strength
    flashlight.decay = THREE.MathUtils.lerp(1.1, 0.95, aimUp);   // a focused beam carries further
  }
  if (!caught) flashlight.decay = 1.1;
  spill.intensity = flashlight.intensity * 0.12;
  spill.target.position.copy(flashlight.target.position);

  // ── HUD ──
  ui.lightBar.style.width = Math.round(light * 100) + '%';
  ui.lightVal.textContent = Math.round(light * 100) + '%';
  ui.nearBar.style.width = Math.round(presence * 100) + '%';
  ui.nearVal.textContent = input.cm ? Math.round(input.cm) + 'cm' : '—';
  ui.btnDot.classList.toggle('on', input.button);
  ui.threat.textContent = Math.round(threat * 100) + '%';
  ui.act.textContent = story.act >= 0 ? ACTS[story.act].title : '—';

  composer.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

if (import.meta.env.DEV) window.tux = { input, story, world, decor, camera, startScare, film, ctrl, gestures, lookBack, menuScene, sound, renderer, scene, composer, returnToMenu, get man() { return tux; }, resetLoop };
if (import.meta.env.DEV) {
  // render one frame on demand and return a small JPEG (works even when the tab is backgrounded)
  window.tux.tick = tick;
  window.tux.snap = (w = 420, q = 0.7) => {
    composer.render();
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * canvas.height / canvas.width);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  };
}
