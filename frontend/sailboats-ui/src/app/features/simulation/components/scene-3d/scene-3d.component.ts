import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import * as THREE from 'three';
import { BoatState, Buoy, HelmControlState, Island, Projectile } from '../../../../store/simulation/simulation.models';

type SailVisualState = 'down' | 'luff' | 'trim' | 'stall' | 'back';

/**
 * WebGL (Three.js) "3D" view of the same server-authoritative simulation that
 * the flat {@code WaterCanvasComponent} renders in 2D. It consumes the identical
 * inputs and reads the live boat list every frame, so no extra state plumbing is
 * needed — this is purely a second way to look at the world (like the old
 * Windows Chess 2D/3D toggle).
 *
 * The vertical axis lives here: boats have a real standing mast, they heel with
 * the server-computed {@code heel} angle and lie flat when {@code capsized}.
 */
@Component({
  selector: 'app-scene-3d',
  standalone: true,
  template: '<div #host class="scene-host" [class.fill]="fill"></div>',
  styles: [
    `
    .scene-host {
      position: relative;
      width: 100%;
      max-width: calc(82vh * 1.78);
      aspect-ratio: 16 / 9;
      margin: 0 auto;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
    }
    .scene-host.fill {
      max-width: none;
      aspect-ratio: auto;
      height: 100%;
      margin: 0;
      border-radius: 0;
      box-shadow: none;
    }
    canvas { display: block; width: 100%; height: 100%; }
    `,
  ],
})
export class Scene3dComponent implements AfterViewInit, OnDestroy {
  @Input() boats: BoatState[] = [];
  @Input() projectiles: Projectile[] = [];
  @Input() buoys: Buoy[] = [];
  @Input() islands: Island[] = [];
  @Input() playerBoatId: string | null = null;
  @Input() controls: HelmControlState | null = null;
  @Input() mainState: SailVisualState = 'down';
  @Input() jibState: SailVisualState = 'down';
  @Input() heel = 0;
  @Input() worldWidth = 28;
  @Input() worldHeight = 15.75;
  @Input() windDirection = 90;
  @Input() windStrength = 5;
  @Input() fill = false;

  @ViewChild('host') hostRef?: ElementRef<HTMLDivElement>;

  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private resizeObserver?: ResizeObserver;
  private frameId: number | null = null;
  private clock = new THREE.Clock();

  // Water: a subdivided plane recentred on the camera each frame, its vertices
  // displaced by travelling sine waves so the sea has real height.
  private water?: THREE.Mesh;
  private waterGeo?: THREE.PlaneGeometry;
  private waterBaseZ: Float32Array = new Float32Array(0);
  private readonly WATER_SIZE = 150;
  private readonly WATER_SEG = 120;

  // Colours shared by the fog, the sky dome's horizon band and the scene
  // background, so the sea fades seamlessly into the horizon. VIEW_RADIUS is the
  // distance at which the fog turns fully opaque — the circle of visibility.
  private readonly HORIZON_COLOR = new THREE.Color('#bcd7e8');
  private readonly SKY_TOP_COLOR = new THREE.Color('#5b93c7');
  private readonly VIEW_RADIUS = 66;

  // Sky dome (a big inverted sphere with a vertical gradient) giving a horizon
  // line where the graded sky meets the fogged sea.
  private sky?: THREE.Mesh;

  // Kielwater (wake): two diverging foam crests (a Kelvin "V") left behind the
  // boat. Each emission point spawns the pair of crests, which fan outward and
  // fade as they age, then expire — so the wake is a spreading, dissolving wave
  // trail, not a single stretched ribbon.
  private wake?: THREE.Mesh;
  private wakeGeo?: THREE.BufferGeometry;
  private wakeTex?: THREE.CanvasTexture;
  private wakeAlpha?: Float32Array; // per-vertex fade, refreshed each frame
  private wakePts: { x: number; z: number; px: number; pz: number; born: number }[] = [];
  private wakePrevStern: { x: number; z: number } | null = null;
  private wakeSpeed = 0; // smoothed hull speed (scene units/sec) driving foam
  private readonly WAKE_MAX = 120; // max live crest points
  private readonly WAKE_SPACING = 0.45; // emit a new crest every this many units
  private readonly WAKE_LIFE = 5.0; // seconds before a crest fully fades away
  private readonly WAKE_SPREAD = 0.32; // how fast (units/sec) crests fan outward
  private readonly WAKE_BASE_HALF = 0.3; // crest offset at the stern (the V apex)
  private readonly WAKE_THICK = 0.42; // radial half-thickness of each crest band
  // Bow wave (the foam "moustache" spreading from the bow) — a flat quad aimed
  // forward and scaled/faded with speed.
  private bowWave?: THREE.Mesh;
  private bowWaveTex?: THREE.CanvasTexture;
  // Per-boat floating nickname labels (billboard sprites above the masthead).
  private nameLabels = new Map<string, THREE.Sprite>();
  // A single-frame jump larger than this (scene units) is a teleport (respawn or
  // lake change), not sailing — we snap the visuals instead of gliding across.
  private readonly TELEPORT_SNAP_DIST = 5;

  // Per-id mesh pools so we add/remove/update meshes as the sim changes.
  private boatMeshes = new Map<string, THREE.Group>();
  private islandMeshes = new Map<string, THREE.Mesh>();
  private projectileMeshes = new Map<string, THREE.Mesh>();
  private buoyMeshes = new Map<string, THREE.Group>();
  private lastIslandsRef: Island[] | null = null;

  // Gunnery visuals: when a projectile with a new id first appears we treat it as
  // a fresh shot — flash+smoke at the muzzle, and the shooter's barrels lift while
  // they reload. projSeen tracks first-seen time per projectile so we can arc it.
  private projSeen = new Map<string, number>();
  private lastFireAt = new Map<string, number>();
  private muzzleFx: { grp: THREE.Group; flash: THREE.Mesh; smoke: THREE.Mesh; born: number; life: number }[] = [];
  private cballGeo?: THREE.SphereGeometry;
  private cballMat?: THREE.MeshStandardMaterial;
  private fxSphereGeo?: THREE.IcosahedronGeometry;
  // Reload time (matches server FIRE_COOLDOWN_MS) and how far the muzzles rise
  // while loading — level when ready, tilted up mid-reload for a longer lob.
  private readonly CANNON_RELOAD_S = 2.0;
  private readonly CANNON_MAX_ELEV = 0.22;

  // Smoothed (interpolated) ground-plane position/heading per boat, keyed by
  // boatId. Network snapshots only arrive ~20x/sec, so without this the hull
  // (and anything locked to it, like the chase camera) would hold still for a
  // few render frames and then visibly snap — read as "vibration"/jitter.
  private boatDisplay = new Map<string, { x: number; y: number; headRad: number }>();


  private sharedGeo: THREE.BufferGeometry[] = [];
  private sharedMat: THREE.Material[] = [];
  private sailTexture?: THREE.CanvasTexture;
  private jibSailTexture?: THREE.CanvasTexture;

  // Manual camera orbit around the boat, driven by the 9 / 0 keys.
  private orbit = 0; // azimuth offset (radians) added to the astern view
  private orbitDir = 0; // -1 / 0 / +1 while a key is held
  private readonly ORBIT_SPEED = 1.8; // radians per second
  private lastTime = 0;

  // Smoothed chase-camera state so the view eases behind the boat with a slight
  // lag on turns instead of snapping (which read as jitter).
  private camYaw: number | null = null; // smoothed astern azimuth (radians)
  private camLook = new THREE.Vector3(); // smoothed look-at target
  private camReady = false;

  // World boundary frame (rebuilt when the lake size changes) and drifting wind
  // streaks. `boundsW/H` remember which world the current fence was built for so
  // we can rebuild it when the player switches to a differently-sized lake.
  private boundsGroup?: THREE.Group;
  private boundsW = 0;
  private boundsH = 0;
  private boundsDisposables: { dispose(): void }[] = [];
  private windStreaks?: THREE.LineSegments;
  private windGeo?: THREE.BufferGeometry;
  private windHeads: Float32Array = new Float32Array(0); // xyz per streak, player-relative
  private windPhase: Float32Array = new Float32Array(0); // per-streak meander phase + speed jitter
  private readonly WIND_COUNT = 130;
  private readonly WIND_BOX = 60; // extent (scene units) of the streak field

  // Top compass strip (a 2D overlay canvas) marking bearings to boats (red)
  // and buoys (green) relative to the player's heading.
  private compassCanvas?: HTMLCanvasElement;
  private compassCtx: CanvasRenderingContext2D | null = null;
  private compassW = 0;
  private compassDpr = 1;
  private readonly COMPASS_H = 46;
  private readonly onOrbitKeyDown = (e: KeyboardEvent) => {
    if (e.key === '9') {
      this.orbitDir = -1;
    } else if (e.key === '0') {
      this.orbitDir = 1;
    }
  };
  private readonly onOrbitKeyUp = (e: KeyboardEvent) => {
    if ((e.key === '9' && this.orbitDir === -1) || (e.key === '0' && this.orbitDir === 1)) {
      this.orbitDir = 0;
    }
  };

  ngAfterViewInit(): void {
    const host = this.hostRef?.nativeElement;
    if (!host) {
      return;
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false;
    host.appendChild(this.renderer.domElement);

    // Overlay canvas for the top compass strip.
    const cc = document.createElement('canvas');
    cc.style.position = 'absolute';
    cc.style.left = '0';
    cc.style.top = '0';
    cc.style.width = '100%';
    cc.style.height = `${this.COMPASS_H}px`;
    cc.style.pointerEvents = 'none';
    host.appendChild(cc);
    this.compassCanvas = cc;
    this.compassCtx = cc.getContext('2d');

    this.scene = new THREE.Scene();
    this.scene.background = this.HORIZON_COLOR.clone();
    // Radial fog fading to the horizon colour: everything past VIEW_RADIUS blends
    // into the horizon, so the visible world is a circle around the player.
    this.scene.fog = new THREE.Fog(this.HORIZON_COLOR.getHex(), this.VIEW_RADIUS * 0.35, this.VIEW_RADIUS);

    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 400);
    this.camera.position.set(0, 24, 20);

    // Lighting: soft sky/ground fill plus an angled sun for shape and shadows.
    const hemi = new THREE.HemisphereLight(0xdff1ff, 0x1e4258, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.15);
    sun.position.set(-30, 45, -18);
    this.scene.add(sun);

    this.buildSky();
    this.buildWater();
    this.buildWake();
    this.buildBowWave();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();

    window.addEventListener('keydown', this.onOrbitKeyDown);
    window.addEventListener('keyup', this.onOrbitKeyUp);

    this.clock.start();
    const loop = () => {
      this.update();
      this.frameId = requestAnimationFrame(loop);
    };
    this.frameId = requestAnimationFrame(loop);
  }

  ngOnDestroy(): void {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
    }
    window.removeEventListener('keydown', this.onOrbitKeyDown);
    window.removeEventListener('keyup', this.onOrbitKeyUp);
    this.resizeObserver?.disconnect();
    this.sharedGeo.forEach((g) => g.dispose());
    this.sharedMat.forEach((m) => m.dispose());
    this.sailTexture?.dispose();
    this.jibSailTexture?.dispose();
    this.boundsDisposables.forEach((d) => d.dispose());
    this.wakeGeo?.dispose();
    this.wakeTex?.dispose();
    this.bowWaveTex?.dispose();
    this.nameLabels.forEach((s) => {
      s.material.map?.dispose();
      s.material.dispose();
    });
    this.waterGeo?.dispose();
    this.windGeo?.dispose();
    this.renderer?.dispose();
    if (this.compassCanvas && this.hostRef) {
      this.hostRef.nativeElement.removeChild(this.compassCanvas);
    }
    if (this.renderer && this.hostRef) {
      this.hostRef.nativeElement.removeChild(this.renderer.domElement);
    }
  }

  private resize(): void {
    const host = this.hostRef?.nativeElement;
    if (!host || !this.renderer || !this.camera) {
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) {
      return;
    }
    this.renderer.setSize(w, h); // updateStyle=true keeps the canvas CSS size in sync with the host
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    if (this.compassCanvas) {
      this.compassDpr = Math.min(window.devicePixelRatio || 1, 2);
      this.compassW = w;
      this.compassCanvas.width = Math.max(1, Math.round(w * this.compassDpr));
      this.compassCanvas.height = Math.round(this.COMPASS_H * this.compassDpr);
    }
  }

  // World (x, y) maps to scene (x, 0, y): the lake lies on the XZ ground plane.
  private playerPos(): { x: number; y: number } {
    const p = this.playerBoatId ? this.boats.find((b) => b.boatId === this.playerBoatId) : undefined;
    return p ? { x: p.x, y: p.y } : { x: this.worldWidth / 2, y: this.worldHeight / 2 };
  }

  private waveHeight(wx: number, wz: number, t: number): number {
    const rad = (this.windDirection * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dz = Math.sin(rad);
    const along = wx * dx + wz * dz;
    const cross = -wx * dz + wz * dx;
    const gust = Math.min(1.6, Math.max(0.6, this.windStrength / 5));
    return (
      0.16 * gust * Math.sin(along * 0.55 - t * 1.6) +
      0.1 * gust * Math.sin(along * 1.1 + cross * 0.4 - t * 2.3) +
      0.05 * Math.sin(cross * 0.9 + t * 1.1)
    );
  }

  // ---- scene construction ----------------------------------------------

  private buildWater(): void {
    this.waterGeo = new THREE.PlaneGeometry(this.WATER_SIZE, this.WATER_SIZE, this.WATER_SEG, this.WATER_SEG);
    this.waterGeo.rotateX(-Math.PI / 2);
    const pos = this.waterGeo.attributes['position'] as THREE.BufferAttribute;
    this.waterBaseZ = Float32Array.from(pos.array as Float32Array);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#1f79a6'),
      roughness: 0.55,
      metalness: 0.15,
      transparent: true,
      opacity: 0.96,
    });
    this.sharedMat.push(mat);
    this.water = new THREE.Mesh(this.waterGeo, mat);
    this.scene?.add(this.water);
  }

  // Sky dome: a large inverted sphere with a vertical gradient (deep blue up
  // high, pale at the horizon). It ignores fog so the graded sky stays crisp,
  // while the fogged sea fades into the matching horizon colour beneath it —
  // together they read as a clean horizon line ringing the player.
  private buildSky(): void {
    const geo = new THREE.SphereGeometry(200, 32, 16);
    this.sharedGeo.push(geo);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      uniforms: {
        topColor: { value: this.SKY_TOP_COLOR.clone() },
        horizonColor: { value: this.HORIZON_COLOR.clone() },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        varying vec3 vPos;
        void main() {
          // Normalised height (0 at horizon, 1 straight up); soft curve so the
          // horizon band is thin and the sky opens up above it.
          float h = clamp(vPos.y / 200.0, 0.0, 1.0);
          float t = pow(h, 0.42);
          gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
        }
      `,
    });
    this.sharedMat.push(mat);
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene?.add(this.sky);
  }

  // Kielwater (wake): two diverging crest ribbons (left & right arm) sharing one
  // geometry. Each of the WAKE_MAX rows holds four vertices (inner/outer edge of
  // each arm's crest band); their positions and per-vertex fade are rewritten
  // every frame from the live emission points. A tiny shader multiplies the foam
  // texture by the per-vertex fade so old crests dissolve cleanly.
  private buildWake(): void {
    const N = this.WAKE_MAX;
    this.wakeGeo = new THREE.BufferGeometry();
    this.wakeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 4 * 3), 3));
    const uv = new Float32Array(N * 4 * 2);
    this.wakeAlpha = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const v = i / (N - 1);
      // 4 verts per row: L-inner, L-outer, R-inner, R-outer. u = 0 inner .. 1 outer.
      const base = i * 4 * 2;
      uv[base + 0] = 0; uv[base + 1] = v;
      uv[base + 2] = 1; uv[base + 3] = v;
      uv[base + 4] = 0; uv[base + 5] = v;
      uv[base + 6] = 1; uv[base + 7] = v;
    }
    this.wakeGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.wakeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.wakeAlpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 4;
      const b = (i + 1) * 4;
      // Left arm (verts +0 inner, +1 outer).
      idx.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1);
      // Right arm (verts +2 inner, +3 outer).
      idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
    }
    this.wakeGeo.setIndex(idx);
    this.wakeTex = this.makeWakeTexture();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { map: { value: this.wakeTex } },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vAlpha = aAlpha;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vec4 tx = texture2D(map, vUv);
          float a = tx.a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(tx.rgb, a);
        }
      `,
    });
    this.sharedMat.push(mat);
    this.wake = new THREE.Mesh(this.wakeGeo, mat);
    this.wake.frustumCulled = false;
    this.wake.renderOrder = 2; // draw over the (transparent) water
    this.scene?.add(this.wake);
  }

  // Foam texture for the crest bands: a soft feathered stripe across the band
  // (u: 0 inner .. 1 outer, bright in the middle) broken up along its length (v)
  // into churned foam clumps so each crest reads as a wave, not a smooth beam.
  private makeWakeTexture(): THREE.CanvasTexture {
    const W = 48;
    const H = 160;
    // A small smoothed 2D value-noise lattice for foam clumps.
    const cols = 10;
    const rows = 40;
    const grid = new Float32Array(cols * rows);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    const sm = (a: number, b: number, f: number) => {
      const s = (1 - Math.cos(f * Math.PI)) * 0.5;
      return a * (1 - s) + b * s;
    };
    const noise = (u: number, v: number) => {
      const fx = u * (cols - 1);
      const fy = v * (rows - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const top = sm(grid[y0 * cols + x0], grid[y0 * cols + x1], tx);
      const bot = sm(grid[y1 * cols + x0], grid[y1 * cols + x1], tx);
      return sm(top, bot, ty);
    };
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.sin(Math.PI * u); // soft at both edges, bright centre
        const soft = Math.pow(edge, 0.5);
        // Clumpy foam: two octaves of noise, biased so there are bright crests
        // and clear gaps rather than a uniform stripe.
        const n = 0.6 * noise(u, v) + 0.4 * noise(u * 2.3, v * 2.3);
        const clump = Math.max(0, Math.min(1, (n - 0.28) / 0.55));
        const foam = 0.25 + 0.95 * clump;
        const a = Math.max(0, Math.min(1, soft * foam));
        const i = (y * W + x) * 4;
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  // Bow wave: a flat quad aimed forward from the bow, textured with two foam
  // "moustache" arms that fan out from the stem. Scaled and faded with speed.
  private buildBowWave(): void {
    const geo = new THREE.BufferGeometry();
    // A quad on the water plane: local +Z is forward, X is lateral, Y ~ 0.
    const positions = new Float32Array([
      -0.5, 0, -0.5,
      0.5, 0, -0.5,
      -0.5, 0, 0.5,
      0.5, 0, 0.5,
    ]);
    const uv = new Float32Array([
      0, 0,
      1, 0,
      0, 1,
      1, 1,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    this.sharedGeo.push(geo);
    this.bowWaveTex = this.makeBowWaveTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: this.bowWaveTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.sharedMat.push(mat);
    this.bowWave = new THREE.Mesh(geo, mat);
    this.bowWave.frustumCulled = false;
    this.bowWave.renderOrder = 2;
    this.scene?.add(this.bowWave);
  }

  // Two soft foam arms diverging from the stem (bottom-centre, v→forward=1).
  private makeBowWaveTexture(): THREE.CanvasTexture {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    // The stem sits at the forward end (v=1 → canvas bottom, since flipY is off).
    // Two thick, soft, tapering strokes peel off the stem and sweep back and
    // outward (decreasing v), like a real bow moustache, plus a bright bloom
    // where the bow parts the water.
    const stemX = S * 0.5;
    const stemY = S * 0.9;
    const arm = (dir: number) => {
      for (let k = 0; k < 24; k++) {
        const s = k / 23;
        // Sweep outward and back; taper the width and fade toward the tail.
        const x = stemX + dir * (9 + s * 48);
        const y = stemY - s * (S * 0.82);
        const r = (11 - s * 9) * 1.2;
        const alpha = 0.55 * (1 - s) * (0.6 + 0.4 * Math.random());
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, `rgba(255,255,255,${alpha})`);
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    arm(1);
    arm(-1);
    // Bright bloom at the stem where the bow parts the water.
    const bloom = ctx.createRadialGradient(stemX, stemY, 0, stemX, stemY, 18);
    bloom.addColorStop(0, 'rgba(255,255,255,0.9)');
    bloom.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(stemX, stemY, 18, 0, Math.PI * 2);
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }

  private ensureIslands(): void {
    if (this.islands === this.lastIslandsRef) {
      return;
    }
    this.lastIslandsRef = this.islands;
    // Rebuild island meshes from scratch when the set changes (rare: on lake join).
    for (const mesh of this.islandMeshes.values()) {
      this.scene?.remove(mesh);
      mesh.geometry.dispose();
    }
    this.islandMeshes.clear();

    const landMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    this.sharedMat.push(landMat);

    let idx = 0;
    for (const island of this.islands) {
      if (!island.points || island.points.length < 3) {
        continue;
      }
      // Centroid for a locally-centred mound.
      let cx = 0;
      let cy = 0;
      for (const p of island.points) {
        cx += p.x;
        cy += p.y;
      }
      cx /= island.points.length;
      cy /= island.points.length;

      // Smoothly sloped mound following the polygon: sandy shore rising to a
      // grassy crown, so islands read as gentle hills rather than blocky cliffs.
      const geo = this.buildIslandGeometry(island.points, cx, cy);
      const mesh = new THREE.Mesh(geo, landMat);
      mesh.position.set(cx, 0, cy);
      this.scene?.add(mesh);
      this.islandMeshes.set(island.id ?? `isl-${idx}`, mesh);
      idx++;
    }
  }

  // Build a smoothly sloped island mound from its shoreline polygon: concentric
  // rings scaled toward the centroid and lifted on a dome profile, with sandy
  // shores blending up to a grassy top. No vertical walls, so no "cliff" look.
  private buildIslandGeometry(points: { x: number; y: number }[], cx: number, cy: number): THREE.BufferGeometry {
    const n = points.length;
    let r = 0;
    for (const p of points) {
      r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    }
    const peakH = Math.min(1.6, Math.max(0.5, r * 0.28));
    const scales = [1.0, 0.72, 0.46, 0.22];
    const dome = (s: number) => 1 - (3 * s * s - 2 * s * s * s); // 1 at centre, 0 at shore
    const sand = new THREE.Color('#d8c68f');
    const grass = new THREE.Color('#6f9350');

    const positions: number[] = [];
    const colors: number[] = [];
    const pushV = (x: number, y: number, z: number) => {
      positions.push(x, y, z);
      const tt = THREE.MathUtils.clamp(y / peakH, 0, 1);
      const c = sand.clone().lerp(grass, THREE.MathUtils.smoothstep(tt, 0.06, 0.5));
      colors.push(c.r, c.g, c.b);
    };

    const ringStart: number[] = [];
    for (let ri = 0; ri < scales.length; ri++) {
      ringStart.push(positions.length / 3);
      const sc = scales[ri];
      const y = ri === 0 ? -0.06 : peakH * dome(sc); // shore dips just under water
      for (let j = 0; j < n; j++) {
        pushV((points[j].x - cx) * sc, y, (points[j].y - cy) * sc);
      }
    }
    const peakIndex = positions.length / 3;
    pushV(0, peakH, 0);

    const indices: number[] = [];
    for (let ri = 0; ri < scales.length - 1; ri++) {
      const a = ringStart[ri];
      const b = ringStart[ri + 1];
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        indices.push(a + j, a + j2, b + j2);
        indices.push(a + j, b + j2, b + j);
      }
    }
    const last = ringStart[scales.length - 1];
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      indices.push(last + j, last + j2, peakIndex);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // Interpolate a value from [t, value] control points (t ascending, 0..1).
  private profile(ctrl: [number, number][], t: number): number {
    if (t <= ctrl[0][0]) return ctrl[0][1];
    if (t >= ctrl[ctrl.length - 1][0]) return ctrl[ctrl.length - 1][1];
    for (let i = 0; i < ctrl.length - 1; i++) {
      const [t0, v0] = ctrl[i];
      const [t1, v1] = ctrl[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return v0 + (v1 - v0) * (f * f * (3 - 2 * f)); // smoothstep
      }
    }
    return ctrl[ctrl.length - 1][1];
  }

  // A lofted sailboat hull: cross-section rings along the length give a pointed
  // bow, rounded bilge, sheer line and a transom, plus a teak deck, a coachroof
  // and a cockpit — so it reads as a real yacht rather than a plank.
  private makeHull(): THREE.Group {
    const grp = new THREE.Group();
    const nSt = 20; // stations along the length
    const nSec = 13; // points across each U-shaped section
    const xStern = -1.2;
    const xBow = 1.42;

    // A long hull, now beamier and lower-freeboard: fine entry at the bow,
    // generous beam carried aft, low topsides.
    const beamCtrl: [number, number][] = [[0, 0.36], [0.14, 0.43], [0.38, 0.5], [0.56, 0.51], [0.74, 0.48], [0.88, 0.33], [0.97, 0.1], [1, 0.0]];
    const beam = (t: number) => this.profile(beamCtrl, t);
    const deckY = (t: number) => 0.27 + 0.11 * Math.pow(t, 1.8) + 0.03 * Math.pow(1 - t, 2.2);
    // Shallow, rounded canoe body — the real draught comes from the fin keel below.
    const bottomY = (t: number) => -0.15 * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.82 + 0.12)));

    const rings: THREE.Vector3[][] = [];
    for (let i = 0; i < nSt; i++) {
      const t = i / (nSt - 1);
      const x = xStern + (xBow - xStern) * t;
      const hb = beam(t);
      const dy = deckY(t);
      const by = bottomY(t);
      const ring: THREE.Vector3[] = [];
      for (let j = 0; j < nSec; j++) {
        const s = j / (nSec - 1); // 0 = port deck edge, 0.5 = keel, 1 = stbd deck edge
        const z = hb * Math.cos(Math.PI * s);
        const y = dy - (dy - by) * Math.pow(Math.sin(Math.PI * s), 1.25);
        ring.push(new THREE.Vector3(x, y, z));
      }
      rings.push(ring);
    }

    // Shell: loft triangles between adjacent station rings.
    const shell: number[] = [];
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
      shell.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < nSt - 1; i++) {
      for (let j = 0; j < nSec - 1; j++) {
        const a = rings[i][j];
        const b = rings[i + 1][j];
        const c = rings[i + 1][j + 1];
        const d = rings[i][j + 1];
        tri(a, b, c);
        tri(a, c, d);
      }
    }
    // Transom cap at the stern (fan from the ring centre), closed across the top.
    const stern = rings[0];
    const sc = new THREE.Vector3(xStern, (stern[0].y + stern[(nSec - 1) / 2 | 0].y) * 0.5, 0);
    for (let j = 0; j < nSec - 1; j++) {
      tri(sc, stern[j + 1], stern[j]);
    }
    tri(sc, stern[0], stern[nSec - 1]); // close the deck-line edge of the transom

    const shellGeo = new THREE.BufferGeometry();
    shellGeo.setAttribute('position', new THREE.Float32BufferAttribute(shell, 3));
    shellGeo.computeVertexNormals();
    this.sharedGeo.push(shellGeo);
    const hullMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#f2f1ec'), roughness: 0.35, metalness: 0.05, side: THREE.DoubleSide });
    this.sharedMat.push(hullMat);
    grp.add(new THREE.Mesh(shellGeo, hullMat));

    // Fin keel with a ballast bulb and a spade rudder — a modern cruiser
    // underbody, so the hull no longer shows a crude deep V.
    const keelMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2b313a'), roughness: 0.5, metalness: 0.25 });
    this.sharedMat.push(keelMat);
    const finGeo = new THREE.BoxGeometry(0.42, 0.64, 0.05);
    finGeo.translate(0, -0.32, 0);
    this.sharedGeo.push(finGeo);
    const fin = new THREE.Mesh(finGeo, keelMat);
    fin.position.set(0.12, -0.1, 0);
    grp.add(fin);
    const bulbGeo = new THREE.SphereGeometry(0.075, 10, 8);
    bulbGeo.scale(2.6, 0.8, 1.05);
    this.sharedGeo.push(bulbGeo);
    const bulb = new THREE.Mesh(bulbGeo, keelMat);
    bulb.position.set(0.12, -0.74, 0);
    grp.add(bulb);
    const rudGeo = new THREE.BoxGeometry(0.12, 0.46, 0.035);
    rudGeo.translate(0, -0.23, 0);
    this.sharedGeo.push(rudGeo);
    const rudder = new THREE.Mesh(rudGeo, keelMat);
    rudder.position.set(-1.02, -0.05, 0);
    grp.add(rudder);

    // Deck: pale non-skid deck. Over the cockpit only the side decks are drawn,
    // leaving the centre open so the recessed cockpit well shows through.
    const cxA = -1.06;
    const cxF = -0.3;
    const zc = 0.22;
    const inCockpit = (x: number) => x > cxA && x < cxF;
    const deck: number[] = [];
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
      deck.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      deck.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    };
    for (let i = 0; i < nSt - 1; i++) {
      const p0 = rings[i][0]; // +z deck edge
      const p1 = rings[i + 1][0];
      const s0 = rings[i][nSec - 1]; // -z deck edge
      const s1 = rings[i + 1][nSec - 1];
      if (inCockpit(p0.x) && inCockpit(p1.x)) {
        const ip0 = new THREE.Vector3(p0.x, p0.y, zc);
        const ip1 = new THREE.Vector3(p1.x, p1.y, zc);
        const is0 = new THREE.Vector3(s0.x, s0.y, -zc);
        const is1 = new THREE.Vector3(s1.x, s1.y, -zc);
        quad(p0, p1, ip1, ip0); // +z side deck (outboard of coaming)
        quad(is0, is1, s1, s0); // -z side deck
      } else {
        quad(p0, p1, s1, s0);
      }
    }
    const deckGeo = new THREE.BufferGeometry();
    deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3));
    deckGeo.computeVertexNormals();
    this.sharedGeo.push(deckGeo);
    const deckMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#d8d2c4'), roughness: 0.92 });
    this.sharedMat.push(deckMat);
    grp.add(new THREE.Mesh(deckGeo, deckMat));

    // Toe rail / rubbing strake: a dark tube following each deck edge — reads as
    // the classic dark sheer stripe and sharpens the hull-to-deck join.
    const railMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#25303c'), roughness: 0.5 });
    this.sharedMat.push(railMat);
    for (const side of [0, nSec - 1]) {
      const pts = rings.map((r) => r[side].clone());
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, 24, 0.022, 6, false);
      this.sharedGeo.push(tube);
      grp.add(new THREE.Mesh(tube, railMat));
    }

    // Coachroof (nadbudówka): a long, low cabin with rounded corners, extruded
    // from a plan-view rounded rectangle so it looks moulded, not a plain box.
    // Sleek flush deck: no tall coachroof (it made the boat look blocky). Only a
    // low, flush sliding companionway hatch and a small forehatch remain.
    const hatchMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#1a2028'), roughness: 0.3, metalness: 0.35 });
    this.sharedMat.push(hatchMat);
    const hatchGeo = new THREE.BoxGeometry(0.42, 0.05, 0.34);
    this.sharedGeo.push(hatchGeo);
    const hatch = new THREE.Mesh(hatchGeo, hatchMat);
    hatch.position.set(-0.18, deckY(0.5) + 0.03, 0);
    grp.add(hatch);
    const foreGeo = new THREE.BoxGeometry(0.22, 0.04, 0.22);
    this.sharedGeo.push(foreGeo);
    const forehatch = new THREE.Mesh(foreGeo, hatchMat);
    forehatch.position.set(0.6, deckY(0.72) + 0.03, 0);
    grp.add(forehatch);

    // Cockpit well: a recess in the deck with a lower sole and coaming walls, so
    // the helm sits down inside the boat rather than on a flat panel.
    const soleY = deckY(0.18) - 0.17;
    const coamTop = deckY(0.18);
    const cockMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#4a3c26'), roughness: 0.92 });
    this.sharedMat.push(cockMat);
    const soleGeo = new THREE.BoxGeometry(cxF - cxA - 0.02, 0.04, zc * 2 - 0.02);
    this.sharedGeo.push(soleGeo);
    const sole = new THREE.Mesh(soleGeo, cockMat);
    sole.position.set((cxA + cxF) / 2, soleY, 0);
    grp.add(sole);
    // Coaming walls from the sole up to deck level.
    const coamMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e7e3d9'), roughness: 0.55, side: THREE.DoubleSide });
    this.sharedMat.push(coamMat);
    const wallH = coamTop - soleY;
    const sideWallGeo = new THREE.BoxGeometry(cxF - cxA, wallH, 0.02);
    this.sharedGeo.push(sideWallGeo);
    for (const z of [zc, -zc]) {
      const w = new THREE.Mesh(sideWallGeo, coamMat);
      w.position.set((cxA + cxF) / 2, (soleY + coamTop) / 2, z);
      grp.add(w);
    }
    const endWallGeo = new THREE.BoxGeometry(0.02, wallH, zc * 2);
    this.sharedGeo.push(endWallGeo);
    for (const x of [cxA, cxF]) {
      const w = new THREE.Mesh(endWallGeo, coamMat);
      w.position.set(x, (soleY + coamTop) / 2, 0);
      grp.add(w);
    }

    // Deck details: steering pedestal + wheel (down in the well), primary winches.
    const metalMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c6ccd2'), roughness: 0.3, metalness: 0.8 });
    this.sharedMat.push(metalMat);
    const deckTopY = deckY(0.24);

    // Pedestal rises from the cockpit sole.
    const pedGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.24, 8);
    pedGeo.translate(0, 0.12, 0);
    this.sharedGeo.push(pedGeo);
    const pedestal = new THREE.Mesh(pedGeo, metalMat);
    pedestal.position.set(-0.6, soleY + 0.02, 0);
    grp.add(pedestal);

    // Wheel: a ring (athwartships) with a hub and spokes on the pedestal.
    const wheelR = 0.16;
    const wheelGeo = new THREE.TorusGeometry(wheelR, 0.013, 6, 20);
    wheelGeo.rotateY(Math.PI / 2); // face aft (plane across the boat)
    this.sharedGeo.push(wheelGeo);
    const wheel = new THREE.Mesh(wheelGeo, metalMat);
    wheel.position.set(-0.6, soleY + 0.3, 0);
    grp.add(wheel);
    const spokeGeo = new THREE.CylinderGeometry(0.006, 0.006, wheelR * 2, 4);
    this.sharedGeo.push(spokeGeo);
    for (let k = 0; k < 3; k++) {
      const spoke = new THREE.Mesh(spokeGeo, metalMat);
      spoke.position.copy(wheel.position);
      spoke.rotation.x = (k * Math.PI) / 3;
      grp.add(spoke);
    }

    // Primary winches on the side decks either side of the cockpit.
    const winchGeo = new THREE.CylinderGeometry(0.05, 0.045, 0.07, 10);
    winchGeo.translate(0, 0.035, 0);
    this.sharedGeo.push(winchGeo);
    for (const sign of [1, -1]) {
      const winch = new THREE.Mesh(winchGeo, metalMat);
      winch.position.set(-0.42, deckTopY, sign * (beam(0.24) - 0.06));
      grp.add(winch);
    }

    // Guard rails: stanchions, lifelines and bow/stern pulpits in stainless.
    grp.add(this.makeRails(beam, deckY, xBow, xStern));
    // Cannons: bow/stern chasers plus broadside guns, mirroring the fire()
    // sides used server-side (bow, stern, port, starboard).
    grp.add(this.makeCannons(beam, deckY, xBow, xStern));

    return grp;
  }

  // Six small cannons matching the fire() sides used server-side (bow, stern,
  // port, starboard). Each gun is aimed along local +X and yawed to its side;
  // the barrel hangs on an elevation pivot so it can lift while reloading.
  private makeCannons(beam: (t: number) => number, deckY: (t: number) => number, xBow: number, xStern: number): THREE.Group {
    const grp = new THREE.Group();

    const barrelMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#15171b'), roughness: 0.4, metalness: 0.8 });
    const baseMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a2c1a'), roughness: 0.85 });
    this.sharedMat.push(barrelMat, baseMat);

    const barrelLen = 0.26;
    // How far the muzzle pokes past the ship's outline — kept small so most of
    // the (now thicker) barrel sits inboard on the deck.
    const protrude = 0.06;
    // Barrel modelled along +X with the breech at the pivot origin, so raising
    // the pivot lifts the muzzle.
    const barrelGeo = new THREE.CylinderGeometry(0.046, 0.058, barrelLen, 12);
    barrelGeo.rotateZ(-Math.PI / 2);
    barrelGeo.translate(barrelLen / 2, 0, 0);
    this.sharedGeo.push(barrelGeo);
    const baseGeo = new THREE.BoxGeometry(0.13, 0.05, 0.1);
    this.sharedGeo.push(baseGeo);

    const pivots: THREE.Object3D[] = [];
    const buildGun = (x: number, z: number, yDeck: number, yaw: number): void => {
      const gun = new THREE.Group();
      gun.position.set(x, yDeck, z);
      gun.rotation.y = yaw;
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.02;
      gun.add(base);
      const pivot = new THREE.Group();
      pivot.name = 'cannonPivot';
      pivot.position.set(0, 0.07, 0);
      pivot.add(new THREE.Mesh(barrelGeo, barrelMat));
      gun.add(pivot);
      pivots.push(pivot);
      grp.add(gun);
    };

    // Broadside guns: seated inboard so the barrel lies across the side deck and
    // only its muzzle clears the rail. port (+z, aim +z) / starboard (-z, aim -z).
    for (const t of [0.34, 0.6]) {
      const x = xStern + (xBow - xStern) * t;
      const inboard = beam(t) - (barrelLen - protrude);
      buildGun(x, inboard, deckY(t), -Math.PI / 2);
      buildGun(x, -inboard, deckY(t), Math.PI / 2);
    }
    // Bow chaser (aim +x) and stern chaser (aim -x), muzzles just past the ends.
    buildGun(xBow - (barrelLen - protrude), 0, deckY(0.9), 0);
    buildGun(xStern + (barrelLen - protrude), 0, deckY(0.08), Math.PI);

    grp.userData['cannonPivots'] = pivots;
    return grp;
  }

  private cannonballGeo(): THREE.SphereGeometry {
    if (!this.cballGeo) {
      this.cballGeo = new THREE.SphereGeometry(0.13, 12, 10);
      this.sharedGeo.push(this.cballGeo);
    }
    return this.cballGeo;
  }

  private cannonballMat(): THREE.MeshStandardMaterial {
    if (!this.cballMat) {
      // A hot iron shot: dark metal with a faint ember glow so it stays readable
      // against the water as it flies.
      this.cballMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#161418'), roughness: 0.45, metalness: 0.6, emissive: new THREE.Color('#ff6a1e'), emissiveIntensity: 0.5 });
      this.sharedMat.push(this.cballMat);
    }
    return this.cballMat;
  }

  private fxSphere(): THREE.IcosahedronGeometry {
    if (!this.fxSphereGeo) {
      this.fxSphereGeo = new THREE.IcosahedronGeometry(1, 2);
      this.sharedGeo.push(this.fxSphereGeo);
    }
    return this.fxSphereGeo;
  }

  // A muzzle flash (bright additive pop) and an expanding smoke puff at a firing
  // cannon, spawned when a new projectile appears near the shooter.
  private spawnMuzzleFlash(x: number, y: number, t: number): void {
    if (!this.scene) {
      return;
    }
    const grp = new THREE.Group();
    grp.position.set(x, this.waveHeight(x, y, t) + 0.42, y);
    const flash = new THREE.Mesh(
      this.fxSphere(),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffdf9e'), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    flash.scale.setScalar(0.42);
    grp.add(flash);
    const smoke = new THREE.Mesh(
      this.fxSphere(),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#e6e6e6'), transparent: true, opacity: 0.7, depthWrite: false, roughness: 1 }),
    );
    smoke.scale.setScalar(0.34);
    grp.add(smoke);
    this.scene.add(grp);
    this.muzzleFx.push({ grp, flash, smoke, born: t, life: 1.1 });
  }

  private updateMuzzleFx(t: number): void {
    for (let i = this.muzzleFx.length - 1; i >= 0; i--) {
      const fx = this.muzzleFx[i];
      const age = (t - fx.born) / fx.life;
      if (age >= 1) {
        this.scene?.remove(fx.grp);
        (fx.flash.material as THREE.Material).dispose();
        (fx.smoke.material as THREE.Material).dispose();
        this.muzzleFx.splice(i, 1);
        continue;
      }
      // Flash: a bright pop that vanishes in the first third of the life.
      const fm = fx.flash.material as THREE.MeshBasicMaterial;
      const fa = Math.max(0, 1 - age / 0.3);
      fm.opacity = fa;
      fx.flash.visible = fa > 0;
      fx.flash.scale.setScalar(0.42 + age * 0.7);
      // Smoke: expand, drift up and fade over the whole life.
      const sm = fx.smoke.material as THREE.MeshStandardMaterial;
      sm.opacity = 0.7 * (1 - age);
      fx.smoke.scale.setScalar(0.34 + age * 1.5);
      fx.smoke.position.y = age * 0.7;
    }
  }

  // Render cannonballs in flight and spawn a muzzle flash for each new shot.
  private syncProjectiles(t: number): void {
    if (!this.scene) {
      return;
    }
    const seen = new Set<string>();
    for (const p of this.projectiles) {
      seen.add(p.id);
      let born = this.projSeen.get(p.id);
      if (born === undefined) {
        born = t;
        this.projSeen.set(p.id, t);
        // A brand-new shot: the shooter just fired (drives barrel elevation) and
        // gets a muzzle flash at the ball's spawn point beside the hull.
        this.lastFireAt.set(p.ownerId, t);
        this.spawnMuzzleFlash(p.x, p.y, t);
      }
      let m = this.projectileMeshes.get(p.id);
      if (!m) {
        m = new THREE.Mesh(this.cannonballGeo(), this.cannonballMat());
        this.projectileMeshes.set(p.id, m);
        this.scene.add(m);
      }
      // A short lob over the projectile's ~1.1s life so it reads as a fired shot.
      const arc = Math.sin(Math.PI * Math.min(1, (t - born) / 1.1));
      m.position.set(p.x, this.waveHeight(p.x, p.y, t) + 0.4 + 1.1 * arc, p.y);
    }
    for (const [id, m] of this.projectileMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        this.projectileMeshes.delete(id);
        this.projSeen.delete(id);
      }
    }
    this.updateMuzzleFx(t);
  }

  // Stainless guard rails around the deck: stanchions carrying a lifeline wire,
  // closed by a bow pulpit and a stern pushpit.
  private makeRails(beam: (t: number) => number, deckY: (t: number) => number, xBow: number, xStern: number): THREE.Group {
    const grp = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c6ccd2'), roughness: 0.3, metalness: 0.75 });
    this.sharedMat.push(metal);
    const wireMat = new THREE.LineBasicMaterial({ color: 0xaab2ba, transparent: true, opacity: 0.85 });
    this.sharedMat.push(wireMat);

    const stanchionH = 0.22;
    const ts = [0.24, 0.42, 0.6, 0.78];
    const stanchGeo = new THREE.CylinderGeometry(0.014, 0.016, stanchionH, 6);
    this.sharedGeo.push(stanchGeo);

    for (const sign of [1, -1]) {
      const tops: THREE.Vector3[] = [];
      for (const t of ts) {
        const x = xStern + (xBow - xStern) * t;
        const z = sign * (beam(t) - 0.02);
        const dy = deckY(t);
        const post = new THREE.Mesh(stanchGeo, metal);
        post.position.set(x, dy + stanchionH / 2, z);
        grp.add(post);
        tops.push(new THREE.Vector3(x, dy + stanchionH, z));
      }
      // Lifeline wire threading the stanchion tops, run forward to the stem and
      // aft to the transom corner.
      const bowTop = new THREE.Vector3(xBow - 0.02, deckY(0.98) + stanchionH, sign * 0.06);
      const sternTop = new THREE.Vector3(xStern + 0.02, deckY(0.02) + stanchionH, sign * (beam(0.02) - 0.03));
      const line = [sternTop, ...tops, bowTop];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(line);
      this.sharedGeo.push(lineGeo);
      grp.add(new THREE.Line(lineGeo, wireMat));
    }

    // Bow pulpit: a stainless tube arcing around the stem.
    const bowRail = new THREE.CatmullRomCurve3([
      new THREE.Vector3(xStern + (xBow - xStern) * ts[3], deckY(ts[3]) + stanchionH, beam(ts[3]) - 0.02),
      new THREE.Vector3(xBow - 0.02, deckY(0.98) + stanchionH, 0.09),
      new THREE.Vector3(xBow + 0.06, deckY(1) + stanchionH * 0.9, 0),
      new THREE.Vector3(xBow - 0.02, deckY(0.98) + stanchionH, -0.09),
      new THREE.Vector3(xStern + (xBow - xStern) * ts[3], deckY(ts[3]) + stanchionH, -(beam(ts[3]) - 0.02)),
    ]);
    const bowTube = new THREE.TubeGeometry(bowRail, 20, 0.018, 6, false);
    this.sharedGeo.push(bowTube);
    grp.add(new THREE.Mesh(bowTube, metal));

    // Stern pushpit: a tube around the transom.
    const sternRail = new THREE.CatmullRomCurve3([
      new THREE.Vector3(xStern + (xBow - xStern) * ts[0], deckY(ts[0]) + stanchionH, beam(ts[0]) - 0.02),
      new THREE.Vector3(xStern + 0.04, deckY(0.02) + stanchionH, beam(0.02) - 0.04),
      new THREE.Vector3(xStern - 0.02, deckY(0) + stanchionH * 0.9, 0),
      new THREE.Vector3(xStern + 0.04, deckY(0.02) + stanchionH, -(beam(0.02) - 0.04)),
      new THREE.Vector3(xStern + (xBow - xStern) * ts[0], deckY(ts[0]) + stanchionH, -(beam(ts[0]) - 0.02)),
    ]);
    const sternTube = new THREE.TubeGeometry(sternRail, 20, 0.018, 6, false);
    this.sharedGeo.push(sternTube);
    grp.add(new THREE.Mesh(sternTube, metal));

    return grp;
  }

  private makeBoat(): THREE.Group {
    const group = new THREE.Group();

    // A proper lofted hull (stations along the length) instead of a flat block.
    group.add(this.makeHull());
    // Heel pivot: everything above the waterline tilts around the forward axis.
    const rig = new THREE.Group();
    rig.name = 'rig';
    group.add(rig);

    // Mast: tall and slim (masthead ~1.4x the hull length above the waterline).
    const mastMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#d8dde2'), roughness: 0.45, metalness: 0.4 });
    const mastGeo = new THREE.CylinderGeometry(0.026, 0.038, 3.85, 10);
    this.sharedGeo.push(mastGeo);
    this.sharedMat.push(mastMat);
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(0.25, 1.9, 0);
    rig.add(mast);

    // Boom: a spar along the foot of the mainsail, re-aimed every frame.
    const boomGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    boomGeo.rotateZ(Math.PI / 2); // lie along local X so we can re-aim it
    this.sharedGeo.push(boomGeo);
    const boom = new THREE.Mesh(boomGeo, mastMat);
    boom.name = 'boom';
    rig.add(boom);

    // Sail material (shared): canvas white with a batten/panel texture.
    const sailMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ffffff'),
      roughness: 0.9,
      side: THREE.DoubleSide,
      map: this.getSailTexture(),
    });
    this.sharedMat.push(sailMat);

    // Mainsail (grot) and jib (fok): segmented planes whose vertices are placed
    // in rig-local space every frame so they belly under wind or flap when luffing.
    const main = this.makeSailMesh(sailMat, 8, 14);
    main.name = 'main';
    rig.add(main);

    // The jib gets its own material/texture (same cloth, plus a navy leech tape)
    // so the extra band doesn't also show up on the mainsail.
    const jibMat = sailMat.clone();
    jibMat.map = this.getJibSailTexture();
    this.sharedMat.push(jibMat);
    const jib = this.makeSailMesh(jibMat, 6, 12);
    jib.name = 'jib';
    rig.add(jib);

    // Masthead burgee: a small triangular pennant coloured per-boat (same hue as
    // the 2D flag). Coloured and aimed downwind each frame in syncBoats.
    const flagMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#ffd166'), roughness: 0.6, side: THREE.DoubleSide });
    const flagGeo = new THREE.BufferGeometry();
    flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0.07, 0,
      0, -0.07, 0,
      -0.34, 0.0, 0,
    ], 3));
    flagGeo.computeVertexNormals();
    this.sharedGeo.push(flagGeo);
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.name = 'flag';
    flag.position.set(0.25, 3.74, 0);
    rig.add(flag);

    // Standing rigging (olinowanie stałe): forestay, backstay, cap shrouds and
    // spreaders. Fixed wires that hold the mast up; they heel with the boat.
    const mastHead = new THREE.Vector3(0.25, 3.68, 0);
    const hounds = new THREE.Vector3(0.25, 2.55, 0);
    const bowTack = new THREE.Vector3(1.34, 0.34, 0);
    const stern = new THREE.Vector3(-1.14, 0.42, 0);
    const chainPort = new THREE.Vector3(0.12, 0.34, 0.44);
    const chainStbd = new THREE.Vector3(0.12, 0.34, -0.44);
    const spreadPort = new THREE.Vector3(0.25, 2.5, 0.3);
    const spreadStbd = new THREE.Vector3(0.25, 2.5, -0.3);

    const wireMat = new THREE.LineBasicMaterial({ color: 0x1a140a, transparent: true, opacity: 0.5 });
    this.sharedMat.push(wireMat);
    const addWire = (a: THREE.Vector3, b: THREE.Vector3) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      this.sharedGeo.push(geo);
      rig.add(new THREE.Line(geo, wireMat));
    };
    addWire(bowTack, mastHead); // forestay (jib luff rides this)
    addWire(mastHead, stern); // backstay
    addWire(mastHead, spreadPort); // cap shroud upper
    addWire(spreadPort, chainPort); // cap shroud lower
    addWire(mastHead, spreadStbd);
    addWire(spreadStbd, chainStbd);

    // Spreaders (saling): short struts pushing the shrouds outboard.
    const spreadMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a2a12'), roughness: 0.8 });
    this.sharedMat.push(spreadMat);
    const spreadGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.56, 5);
    spreadGeo.rotateX(Math.PI / 2); // lie across the beam (local Z)
    this.sharedGeo.push(spreadGeo);
    const spreaders = new THREE.Mesh(spreadGeo, spreadMat);
    spreaders.position.set(0.25, 2.5, 0);
    rig.add(spreaders);

    // Roller-furling foil + furled cloth on the forestay: a cylinder along the
    // stay whose radius grows as the jib rolls away (thin foil when fully unfurled).
    const furlDir = mastHead.clone().sub(bowTack);
    const furlLen = furlDir.length();
    // Tapered roll: the jib is triangular, so little cloth rolls up near the head
    // (thin at the top) and more toward the tack (a touch wider at the bottom).
    // +Y of the cylinder ends at the masthead, -Y at the bow tack.
    const furlGeo = new THREE.CylinderGeometry(0.28, 1, furlLen, 8);
    this.sharedGeo.push(furlGeo);
    const furl = new THREE.Mesh(furlGeo, sailMat);
    furl.name = 'jibFurl';
    furl.position.copy(bowTack).add(mastHead).multiplyScalar(0.5);
    furl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), furlDir.normalize());
    rig.add(furl);

    // Running rigging (sheets): ropes from each sail's clew back to the hull, so
    // the sails are visibly trimmed rather than floating free. Endpoints are
    // re-set every frame from the live clew positions.
    const sheetMat = new THREE.LineBasicMaterial({ color: 0x2b2317 });
    this.sharedMat.push(sheetMat);
    const mainSheetGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.sharedGeo.push(mainSheetGeo);
    const mainSheet = new THREE.Line(mainSheetGeo, sheetMat);
    mainSheet.name = 'mainSheet';
    rig.add(mainSheet);
    // Outhaul: the line holding the sail's clew out to the fixed end of the boom.
    // When furled the clew sits inboard, so this line spans the remaining gap.
    const mainOuthaulGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.sharedGeo.push(mainOuthaulGeo);
    const mainOuthaul = new THREE.Line(mainOuthaulGeo, sheetMat);
    mainOuthaul.name = 'mainOuthaul';
    rig.add(mainOuthaul);
    const jibSheetGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.sharedGeo.push(jibSheetGeo);
    const jibSheet = new THREE.Line(jibSheetGeo, sheetMat);
    jibSheet.name = 'jibSheet';
    rig.add(jibSheet);

    this.scene?.add(group);
    return group;
  }

  // Draws the common cloth pattern (panel seams, battens, foot band) shared by
  // both sail textures. u=0 is the luff (canvas left), u=1 the leech (canvas
  // right); v=0 is the foot (canvas bottom), v=1 the head (canvas top).
  private drawSailCloth(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#f5f8fc';
    ctx.fillRect(0, 0, 128, 256);
    // Panel seams: faint horizontal cloth panels across the whole sail.
    ctx.strokeStyle = 'rgba(120, 140, 160, 0.18)';
    ctx.lineWidth = 1;
    for (let y = 16; y < 256; y += 22) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(128, y);
      ctx.stroke();
    }
    // Battens: heavier lines from ~30% chord out to the leech (canvas right edge).
    ctx.strokeStyle = 'rgba(70, 92, 112, 0.45)';
    ctx.lineWidth = 3;
    for (const v of [0.2, 0.4, 0.6, 0.8]) {
      const y = (1 - v) * 256; // texture flipY => canvas top is the head (v=1)
      ctx.beginPath();
      ctx.moveTo(38, y);
      ctx.lineTo(128, y);
      ctx.stroke();
    }
    // Foot band (lik dolny): a navy tape along the foot edge (v=0 => canvas
    // bottom) so the lower contour of each sail reads clearly against the sky.
    ctx.fillStyle = '#16225c';
    ctx.fillRect(0, 248, 128, 8);
    ctx.fillStyle = 'rgba(22, 34, 92, 0.55)';
    ctx.fillRect(0, 244, 128, 3);
  }

  // Sail cloth texture for the mainsail (grot). Shared by all boats' mainsails.
  private getSailTexture(): THREE.CanvasTexture {
    if (this.sailTexture) {
      return this.sailTexture;
    }
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    this.drawSailCloth(c.getContext('2d')!);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    this.sailTexture = tex;
    return tex;
  }

  // Sail cloth texture for the jib (fok): the same cloth as the mainsail, plus
  // a navy leech band (lik wolny) — on the jib the leech is a free edge (not
  // laced to a spar like the mainsail's leech/foot area near the boom), so it
  // gets its own boltrope tape mirroring the foot band.
  private getJibSailTexture(): THREE.CanvasTexture {
    if (this.jibSailTexture) {
      return this.jibSailTexture;
    }
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    this.drawSailCloth(ctx);
    // Leech band (lik wolny): the same navy tape mirrored along the leech edge
    // (u=1 => canvas right side).
    ctx.fillStyle = '#16225c';
    ctx.fillRect(120, 0, 8, 256);
    ctx.fillStyle = 'rgba(22, 34, 92, 0.55)';
    ctx.fillRect(117, 0, 3, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    this.jibSailTexture = tex;
    return tex;
  }

  // Deterministic per-boat flag hue (matches the 2D burgee colour).
  private flagHue(boatId: string): number {
    let hash = 0;
    for (let i = 0; i < boatId.length; i++) {
      hash = (hash * 31 + boatId.charCodeAt(i)) >>> 0;
    }
    return hash % 360;
  }

  // A flat segmented plane we later reshape into a bellied/luffing sail. The
  // normalised (u, v) of each vertex is cached so we can rebuild it every frame.
  private makeSailMesh(mat: THREE.Material, nu: number, nv: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(1, 1, nu, nv);
    this.sharedGeo.push(geo);
    const pos = geo.attributes['position'] as THREE.BufferAttribute;
    const uv = new Float32Array((pos.count) * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) + 0.5; // u: 0 at luff, 1 at leech
      uv[i * 2 + 1] = pos.getY(i) + 0.5; // v: 0 at foot, 1 at head
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData['uv'] = uv;
    return mesh;
  }

  // Reshape a sail: place every vertex in rig-local space from the sail's three
  // corners, add a leeward belly (camber) and, when luffing, a flapping ripple.
  private updateSail(
    mesh: THREE.Mesh,
    tack: THREE.Vector3,
    head: THREE.Vector3,
    clew: THREE.Vector3,
    leewardSign: number,
    belly: number,
    flutter: number,
    phase: number,
    twist: number = 0.14,
    roach: number = 0,
  ): void {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.attributes['position'] as THREE.BufferAttribute;
    const uv = mesh.userData['uv'] as Float32Array;
    const Lv = new THREE.Vector3();
    const Tv = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const u = uv[i * 2];
      const v = uv[i * 2 + 1];
      // Luff edge (tack->head at the mast/stay) and leech edge (clew->head).
      Lv.copy(tack).lerp(head, v);
      Tv.copy(clew).lerp(head, v);
      p.copy(Lv).lerp(Tv, u);
      // Roach: a convex leech (as a real mainsail has), bulging aft, strongest
      // mid-height and only near the leech (u -> 1). -x is toward the stern.
      if (roach) {
        p.x -= roach * Math.sin(Math.PI * v) * u * u;
      }
      // Aerofoil camber: draft biased ~40% aft of the luff. Everything is faded
      // to zero at the head (v -> 1) so the sail converges cleanly to the head
      // point instead of flaring into a ragged top.
      const headTaper = 1 - v * v;
      const draft = Math.sin(Math.PI * Math.pow(u, 0.72));
      const camber = belly * draft * headTaper;
      // Leech twists open toward the head, then closes back to the point.
      const twistZ = twist * u * v * headTaper;
      // Luffing shiver: a travelling ripple, strongest along the leech.
      const flap = flutter * Math.sin(u * 7.5 + v * 2.2 + phase * 11) * (0.15 + 0.85 * u * u) * headTaper;
      p.z += leewardSign * (camber + twistZ) + flap;
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  // Green health buoy carrying a white "+" topmark; matches the 2D pickup.
  private makeBuoy(): THREE.Group {
    const grp = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1f9d52, roughness: 0.45, metalness: 0.1, emissive: 0x0c5228, emissiveIntensity: 0.5 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, emissive: 0x2a4a38, emissiveIntensity: 0.25 });
    this.sharedMat.push(bodyMat, whiteMat);

    const bodyGeo = new THREE.CylinderGeometry(0.34, 0.44, 0.78, 14);
    this.sharedGeo.push(bodyGeo);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.42;
    grp.add(body);

    const capGeo = new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    this.sharedGeo.push(capGeo);
    const cap = new THREE.Mesh(capGeo, bodyMat);
    cap.position.y = 0.81;
    grp.add(cap);

    const bandGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.16, 14);
    this.sharedGeo.push(bandGeo);
    const band = new THREE.Mesh(bandGeo, whiteMat);
    band.position.y = 0.55;
    grp.add(band);

    // White "+" painted flat on the buoy's own surface (not floating above it):
    // one cross embossed on the dome top, plus a cross on each of the four
    // sides of the cylindrical body so it reads from any viewing angle.
    const barVGeo = new THREE.BoxGeometry(0.1, 0.34, 0.05);
    const barHGeo = new THREE.BoxGeometry(0.34, 0.1, 0.05);
    this.sharedGeo.push(barVGeo, barHGeo);
    const addSideCross = (angle: number) => {
      const g = new THREE.Group();
      const barV = new THREE.Mesh(barVGeo, whiteMat);
      const barH = new THREE.Mesh(barHGeo, whiteMat);
      g.add(barV, barH);
      g.position.set(0, 0.42, 0);
      g.rotation.y = angle;
      g.translateZ(0.42);
      grp.add(g);
    };
    addSideCross(0);
    addSideCross(Math.PI / 2);
    addSideCross(Math.PI);
    addSideCross(-Math.PI / 2);

    // Flat cross on top of the dome so it also reads from a bird's-eye view.
    const topVGeo = new THREE.BoxGeometry(0.09, 0.05, 0.3);
    const topHGeo = new THREE.BoxGeometry(0.3, 0.05, 0.09);
    this.sharedGeo.push(topVGeo, topHGeo);
    const topV = new THREE.Mesh(topVGeo, whiteMat);
    topV.position.y = 1.13;
    grp.add(topV);
    const topH = new THREE.Mesh(topHGeo, whiteMat);
    topH.position.y = 1.13;
    grp.add(topH);


    return grp;
  }

  private syncBuoys(t: number): void {
    if (!this.scene) {
      return;
    }
    const seen = new Set<string>();
    for (const buoy of this.buoys) {
      seen.add(buoy.id);
      let g = this.buoyMeshes.get(buoy.id);
      if (!g) {
        g = this.makeBuoy();
        this.buoyMeshes.set(buoy.id, g);
        this.scene.add(g);
      }
      const wy = this.waveHeight(buoy.x, buoy.y, t);
      g.position.set(buoy.x, wy - 0.12, buoy.y);
      g.rotation.y = t * 0.5; // slow spin keeps the "+" readable
    }
    for (const [id, g] of this.buoyMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(g);
        this.buoyMeshes.delete(id);
      }
    }
  }

  // Draw the top compass strip: coloured dots for boats/islands/buoys placed by
  // their bearing relative to the player's heading (dead ahead = centre).
  private drawCompass(player: BoatState | undefined): void {
    const ctx = this.compassCtx;
    const cv = this.compassCanvas;
    if (!ctx || !cv || !player) {
      return;
    }
    const W = this.compassW;
    const H = this.COMPASS_H;
    const dpr = this.compassDpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const barY = 8;
    const barH = 24;
    const cxBar = W / 2;
    // Background strip.
    ctx.fillStyle = 'rgba(6, 20, 32, 0.42)';
    this.roundRectPath(ctx, 8, barY, W - 16, barH, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const span = 360; // full circle mapped across the strip (game-style compass)
    const half = span / 2;
    const usable = W / 2 - 22;
    const heading = player.heading;
    const midY = barY + barH / 2;

    // Faint tick marks every 45°.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    for (let d = -180; d <= 180; d += 45) {
      const x = cxBar + (d / half) * usable;
      const big = d === 0;
      ctx.beginPath();
      ctx.moveTo(x, barY + (big ? 3 : 6));
      ctx.lineTo(x, barY + barH - (big ? 3 : 6));
      ctx.stroke();
    }

    const plot = (tx: number, ty: number, color: string, r: number) => {
      const dx = tx - player.x;
      const dy = ty - player.y;
      if (dx === 0 && dy === 0) {
        return;
      }
      let rel = (Math.atan2(dy, dx) * 180) / Math.PI - heading;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      if (Math.abs(rel) > half) {
        return;
      }
      const x = cxBar + (rel / half) * usable;
      ctx.beginPath();
      ctx.arc(x, midY, r + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, midY, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };

    // Buoys (green).
    for (const buoy of this.buoys) {
      plot(buoy.x, buoy.y, '#3ee07f', 4);
    }
    // Other boats (red).
    for (const boat of this.boats) {
      if (boat.boatId === this.playerBoatId) {
        continue;
      }
      plot(boat.x, boat.y, '#ff5a4d', 4.5);
    }

    // Forward marker (a small white triangle at the centre).
    ctx.beginPath();
    ctx.moveTo(cxBar, barY - 1);
    ctx.lineTo(cxBar - 6, barY - 8);
    ctx.lineTo(cxBar + 6, barY - 8);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  private roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  private syncBoats(t: number, dt: number): void {
    const seen = new Set<string>();
    // Frame-rate-independent smoothing so hull position/heading glide between
    // the ~50ms network snapshots instead of freezing then jumping.
    const posK = 1 - Math.exp(-9 * dt);
    const headK = 1 - Math.exp(-7 * dt);
    for (const boat of this.boats) {
      seen.add(boat.boatId);
      let g = this.boatMeshes.get(boat.boatId);
      if (!g) {
        g = this.makeBoat();
        g.scale.setScalar(1.3);
        // Cache the cannon elevation pivots so we can animate them each frame.
        const pivots: THREE.Object3D[] = [];
        g.traverse((o) => {
          if (o.name === 'cannonPivot') {
            pivots.push(o);
          }
        });
        g.userData['cannonPivots'] = pivots;
        this.boatMeshes.set(boat.boatId, g);
      }

      // Smooth the boat's ground-plane position toward the latest server value.
      let disp = this.boatDisplay.get(boat.boatId);
      const targetHead = (boat.heading * Math.PI) / 180;
      if (!disp) {
        disp = { x: boat.x, y: boat.y, headRad: targetHead };
        this.boatDisplay.set(boat.boatId, disp);
      } else if (Math.hypot(boat.x - disp.x, boat.y - disp.y) > this.TELEPORT_SNAP_DIST) {
        // Teleport (respawn / lake change): snap the display straight to the new
        // spot instead of lerping the hull across the whole map at "warp speed".
        disp.x = boat.x;
        disp.y = boat.y;
        disp.headRad = targetHead;
        if (boat.boatId === this.playerBoatId) {
          this.camReady = false; // let the chase camera jump, not fly, to the boat
          this.wakePts.length = 0; // and don't smear a wake across the jump
          this.wakePrevStern = null;
          this.wakeSpeed = 0;
        }
      } else {
        disp.x += (boat.x - disp.x) * posK;
        disp.y += (boat.y - disp.y) * posK;
        let hd = targetHead - disp.headRad;
        while (hd > Math.PI) hd -= Math.PI * 2;
        while (hd < -Math.PI) hd += Math.PI * 2;
        disp.headRad += hd * headK;
      }

      // Float the boat on the wave surface at its (smoothed) position.
      const wy = this.waveHeight(disp.x, disp.y, t);
      g.position.set(disp.x, wy, disp.y);

      // Heel the WHOLE boat (hull + rig) around its forward axis: yaw to the
      // heading, then roll to the heel angle. Eased for smoothness.
      const capsized = !!boat.capsized;
      const heelDeg = capsized ? 82 * Math.sign(boat.heel || 1) : boat.heel ?? 0;
      const targetRoll = (heelDeg * Math.PI) / 180;
      const curRoll = (g.userData['heelRad'] as number) ?? 0;
      const heelRad = curRoll + (targetRoll - curRoll) * 0.15;
      g.userData['heelRad'] = heelRad;
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -disp.headRad);
      const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), heelRad);
      g.quaternion.copy(yaw).multiply(roll);

      const rig = g.getObjectByName('rig') as THREE.Group | undefined;
      if (rig) {
        this.updateRig(boat, rig, heelDeg, capsized, t);
        // Masthead burgee: per-boat colour (matches 2D), streaming downwind.
        const flag = rig.getObjectByName('flag') as THREE.Mesh | undefined;
        if (flag) {
          const fm = flag.material as THREE.MeshStandardMaterial;
          fm.color.setHSL(this.flagHue(boat.boatId) / 360, 0.82, 0.56);
          // Point the burgee downwind (the fly models -x, so add PI).
          flag.rotation.y = Math.PI + ((boat.heading - this.windDirection) * Math.PI) / 180;
          flag.rotation.z = Math.sin(t * 6 + boat.x) * 0.07; // gentle flutter
        }
      }

      // Cannon elevation: barrels sit level when ready and lift while reloading,
      // easing back down to level as the gun crew finishes loading.
      const pivots = g.userData['cannonPivots'] as THREE.Object3D[] | undefined;
      if (pivots && pivots.length) {
        const firedAt = this.lastFireAt.get(boat.boatId);
        let elev = 0;
        if (firedAt !== undefined) {
          const progress = (t - firedAt) / this.CANNON_RELOAD_S;
          if (progress < 1) {
            elev = this.CANNON_MAX_ELEV * Math.sin(Math.PI * progress);
          }
        }
        const k = 1 - Math.exp(-10 * dt);
        for (const pv of pivots) {
          pv.rotation.z += (elev - pv.rotation.z) * k;
        }
      }

      const player = boat.boatId === this.playerBoatId;
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && player) {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
          if (m && 'emissive' in m && o.parent?.name !== 'rig') {
            m.emissive = new THREE.Color('#3a2e00');
          }
        }
      });

      // Floating nickname above the masthead (billboard sprite, world-space so it
      // never heels with the hull). Redraw only when the name (or anchor) changes.
      const label = this.ensureNameLabel(boat.boatId, boat.name, !!boat.anchored && !boat.sunk);
      if (label) {
        label.visible = !boat.sunk;
        label.position.set(disp.x, wy + 5.7, disp.y);
      }
    }

    // Remove meshes (and display state) for boats that left.
    for (const [id, g] of this.boatMeshes) {
      if (!seen.has(id)) {
        this.scene?.remove(g);
        this.boatMeshes.delete(id);
        this.boatDisplay.delete(id);
        const label = this.nameLabels.get(id);
        if (label) {
          this.scene?.remove(label);
          label.material.map?.dispose();
          label.material.dispose();
          this.nameLabels.delete(id);
        }
      }
    }
  }

  // Get or (re)build the nickname billboard for a boat, redrawing its texture
  // only when the displayed name actually changes.
  private ensureNameLabel(boatId: string, name?: string, anchored = false): THREE.Sprite | undefined {
    const text = (name ?? '').trim() || 'Żeglarz';
    const key = text + (anchored ? '|a' : '');
    let sprite = this.nameLabels.get(boatId);
    if (sprite && sprite.userData['name'] === key) {
      return sprite;
    }
    const { canvas, aspect } = this.drawNameCanvas(text, anchored);
    if (!sprite) {
      const mat = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0.92,
      });
      sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 6;
      this.nameLabels.set(boatId, sprite);
      this.scene?.add(sprite);
    } else {
      sprite.material.map?.dispose();
      sprite.material.map = new THREE.CanvasTexture(canvas);
      sprite.material.needsUpdate = true;
    }
    sprite.userData['name'] = key;
    const height = 0.82; // world units tall
    sprite.scale.set(height * aspect, height, 1);
    return sprite;
  }

  // Render a nickname onto a canvas: a soft translucent pill with crisp white
  // text, optionally preceded by a small anchor icon when the boat is anchored.
  private drawNameCanvas(text: string, anchored = false): { canvas: HTMLCanvasElement; aspect: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fontPx = 34;
    const padX = 22;
    const iconW = anchored ? fontPx + 8 : 0; // reserved space for the anchor glyph
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
    const textW = Math.ceil(measure.measureText(text).width);
    const cw = textW + iconW + padX * 2;
    const ch = fontPx + 24;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    // Rounded translucent pill background.
    const r = ch / 2;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(cw, 0, cw, ch, r);
    ctx.arcTo(cw, ch, 0, ch, r);
    ctx.arcTo(0, ch, 0, 0, r);
    ctx.arcTo(0, 0, cw, 0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 18, 30, 0.5)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(143, 227, 255, 0.35)';
    ctx.stroke();
    // Anchor icon on the left when anchored.
    if (anchored) {
      this.drawAnchorIcon(ctx, padX + iconW / 2 - 4, ch / 2, fontPx * 0.44);
    }
    // Text (shifted right past any icon).
    ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf6ff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 3;
    ctx.fillText(text, padX + iconW + textW / 2, ch / 2 + 1);
    return { canvas, aspect: cw / ch };
  }

  // A small vector anchor glyph (ring, shank, stock, curved arms) drawn centred
  // on (cx, cy) with the given half-height, used in the anchored boat label.
  private drawAnchorIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
    ctx.save();
    ctx.strokeStyle = '#eaf6ff';
    ctx.fillStyle = '#eaf6ff';
    ctx.lineWidth = Math.max(2, s * 0.2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 2;
    const top = cy - s;
    const bot = cy + s;
    // Ring at the top of the shank.
    ctx.beginPath();
    ctx.arc(cx, top, s * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    // Shank down the middle.
    ctx.beginPath();
    ctx.moveTo(cx, top + s * 0.3);
    ctx.lineTo(cx, bot);
    ctx.stroke();
    // Stock (crossbar).
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.52, top + s * 0.66);
    ctx.lineTo(cx + s * 0.52, top + s * 0.66);
    ctx.stroke();
    // Curved arms (the ∪ at the crown) plus fluke tips.
    const cyc = bot - s * 0.2;
    const rad = s * 0.78;
    const a0 = Math.PI * 0.12;
    const a1 = Math.PI * 0.88;
    ctx.beginPath();
    ctx.arc(cx, cyc, rad, a0, a1, false);
    ctx.stroke();
    for (const a of [a0, a1]) {
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rad, cyc + Math.sin(a) * rad, s * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Reshape both sails, aim the boom, and toggle rig visibility for one boat.
  private updateRig(boat: BoatState, rig: THREE.Group, heelDeg: number, capsized: boolean, t: number): void {
    const player = boat.boatId === this.playerBoatId;
    const c: HelmControlState | null = player ? this.controls : null;

    // Deploy / sheet: the player has a detailed helm exposing explicit deploy
    // state. Other boats only report a single sailTrim (a drive/thrust ratio,
    // near zero while luffing or in irons), so we can't infer "sail down" from
    // it — a luffing sail also has ~0 trim. Instead assume any boat that is
    // sailing (not anchored/sunk) has both sails hoisted, and use sailTrim only
    // to drive the sheet/camber and to decide whether the cloth is drawing or
    // luffing — never whether it's visible.
    const trim = this.clamp01(boat.sailTrim ?? 0);
    const hoisted = !boat.anchored && !boat.sunk;
    const mainDeploy = c ? this.clamp01(c.main.deploy) : hoisted ? 1 : 0;
    const mainSheet = c ? this.clamp01(c.main.sheet) : trim;
    const jibDeploy = c ? this.clamp01(c.jib.deploy) : hoisted ? 1 : 0;
    const jibSheet = c ? this.clamp01(c.jib.sheet) : trim;

    // Luffing: the player exposes explicit sail state; for others a low drive
    // ratio (in irons, tacking through the wind, or an eased sheet) means the
    // sail is up but luffing rather than drawing.
    const mainLuff = player ? this.mainState === 'luff' || this.mainState === 'down' : mainDeploy > 0 && trim < 0.12;
    const jibLuff = player ? this.jibState === 'luff' || this.jibState === 'down' : jibDeploy > 0 && trim < 0.12;


    const lee = heelDeg >= 0 ? 1 : -1;
    const gust = this.clamp(this.windStrength / 5, 0.6, 1.6);
    // Point of sail (0 = head to wind, 180 = dead run): sails are fuller (more
    // belly) the deeper the course, and flatter ("bladed") the closer to the wind.
    const windFrom = this.windDirection + 180;
    let bd = (boat.heading - windFrom) % 360;
    if (bd < -180) {
      bd += 360;
    } else if (bd > 180) {
      bd -= 360;
    }
    const beta = Math.abs(bd);
    const camberScale = 0.35 + 0.85 * (beta / 180);

    const main = rig.getObjectByName('main') as THREE.Mesh | undefined;
    const boom = rig.getObjectByName('boom') as THREE.Mesh | undefined;
    const jib = rig.getObjectByName('jib') as THREE.Mesh | undefined;
    const mainSheetLine = rig.getObjectByName('mainSheet') as THREE.Line | undefined;
    const mainOuthaulLine = rig.getObjectByName('mainOuthaul') as THREE.Line | undefined;
    const jibSheetLine = rig.getObjectByName('jibSheet') as THREE.Line | undefined;

    // ---- Mainsail (grot) ----
    if (main) {
      const show = !capsized && mainDeploy > 0.05;
      main.visible = show;
      const boomY = 0.62;
      // The boom is a fixed-length alloy spar hinged at the gooseneck.
      const boomLen = 1.25;
      const boomAngle = show ? 0.12 + (1 - mainSheet) * 0.95 : 0.1;
      const tack = new THREE.Vector3(0.25, boomY, 0);
      const boomDir = new THREE.Vector3(-Math.cos(boomAngle), 0, lee * Math.sin(boomAngle));
      const boomEnd = tack.clone().add(boomDir.clone().multiplyScalar(boomLen));
      if (boom) {
        boom.visible = !capsized;
        this.alignSpar(boom, tack, boomEnd);
      }
      if (show) {
        // In-mast furling: the luff rolls onto a foil hidden INSIDE the mast (no
        // visible roll). Furling shrinks the sail toward the mast along BOTH the
        // boom (clew slides in) and the mast (head comes down) by the same
        // factor, so the triangle stays proportional and rolls into the mast
        // with no stretching of the cloth or texture.
        const set = 0.1 + 0.9 * mainDeploy; // 0 = rolled into the mast, 1 = full
        const clew = tack.clone().add(boomDir.clone().multiplyScalar(boomLen * set));
        const headY = boomY + 2.9 * set;
        const head = new THREE.Vector3(0.25, headY, 0);
        const power = mainDeploy * (0.35 + 0.65 * mainSheet);
        const belly = mainLuff ? 0.05 : 0.36 * power * camberScale;
        const flutter = mainLuff ? 0.14 * gust : 0.02;
        this.updateSail(main, tack, head, clew, lee, belly, flutter, t, 0.12, 0.22);
        // Outhaul: from the clew out to the fixed boom end (spans the gap while
        // the sail is partly furled).
        if (mainOuthaulLine) {
          mainOuthaulLine.visible = true;
          this.setLine(mainOuthaulLine, clew, boomEnd);
        }
        // Mainsheet: from the fixed boom end down to the traveller near the stern.
        if (mainSheetLine) {
          mainSheetLine.visible = true;
          this.setLine(mainSheetLine, boomEnd, new THREE.Vector3(-1.05, 0.42, 0));
        }
      } else {
        if (mainSheetLine) {
          mainSheetLine.visible = false;
        }
        if (mainOuthaulLine) {
          mainOuthaulLine.visible = false;
        }
      }
    }

    // ---- Jib (fok) on a roller furler ----
    // The luff is fixed on the forestay (bow -> masthead); furling rolls the
    // cloth away toward the stay, so the clew collapses toward the luff as the
    // deploy drops and a fatter "sausage" of rolled sail shows on the foil.
    const furl = rig.getObjectByName('jibFurl') as THREE.Mesh | undefined;
    if (jib) {
      const rolled = this.clamp01(jibDeploy);
      const show = !capsized && rolled > 0.02;
      jib.visible = show;
      if (show) {
        // Butterfly / goose-wing: on a run the jib can be winged to the side it
        // is actually sheeted (jib.side), opposite the main, instead of always
        // following the heel-based leeward side.
        const jibSide = c && c.jib.side ? c.jib.side : lee;
        // Tack lifted well clear of the foredeck so the sail can never sweep
        // down through the hull; the luff runs the full forestay to the masthead.
        const tack = new THREE.Vector3(1.3, 0.55, 0);
        const fullHead = new THREE.Vector3(0.28, 3.55, 0);
        const jibFoot = 0.72;
        const jibAngle = 0.22 + (1 - jibSheet) * 0.85;
        const fullClew = new THREE.Vector3(
          1.3 - Math.cos(jibAngle) * jibFoot,
          0.82,
          jibSide * Math.sin(jibAngle) * jibFoot,
        );
        // Furling reduces the whole sail proportionally: the head slides down the
        // forestay and the clew comes in toward the tack by the same factor, so
        // the foot (lik dolny) and leech (lik wolny) shrink equally instead of
        // only the foot collapsing.
        const set = 0.1 + 0.9 * rolled;
        const head = tack.clone().lerp(fullHead, set);
        const clew = tack.clone().lerp(fullClew, set);
        const power = rolled * (0.4 + 0.6 * jibSheet);
        // A fuller, more convex jib than the main; fuller the deeper the course.
        const belly = jibLuff ? 0.06 : 0.5 * power * camberScale;
        const flutter = jibLuff ? 0.18 * gust : 0.03;
        this.updateSail(jib, tack, head, clew, jibSide, belly, flutter, t + 1.7, 0.26);
        // Jib sheet: from the clew back to a fairlead on the side deck.
        if (jibSheetLine) {
          jibSheetLine.visible = true;
          this.setLine(jibSheetLine, clew, new THREE.Vector3(-0.05, 0.46, jibSide * 0.32));
        }
      } else if (jibSheetLine) {
        jibSheetLine.visible = false;
      }
      if (furl) {
        // Thin foil when unfurled, only a slim (tapered) roll of cloth when
        // furled away — noticeably narrower than a full sail-sized sausage.
        furl.visible = !capsized;
        const r = 0.011 + 0.021 * (1 - this.clamp01(jibDeploy));
        furl.scale.set(r, 1, r);
      }
    }
  }

  // Re-point a 2-vertex line between a and b.
  private setLine(line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3): void {
    const attr = (line.geometry as THREE.BufferGeometry).attributes['position'] as THREE.BufferAttribute;
    attr.setXYZ(0, a.x, a.y, a.z);
    attr.setXYZ(1, b.x, b.y, b.z);
    attr.needsUpdate = true;
  }

  // Aim a unit-length spar (modelled along +X) so it spans from a to b.
  private alignSpar(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    const dir = b.clone().sub(a);
    const len = dir.length();
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(len, 1, 1);
    if (len > 1e-4) {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.normalize());
    }
  }

  private clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  private clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // Visible boundary of the playable area: a wall of cracked glass around the
  // world edge. Rebuilt whenever the lake size changes (so switching between a
  // small and a large lake no longer leaves the wall stranded at the old size).
  private ensureWorldBounds(): void {
    if (!this.scene) {
      return;
    }
    if (this.boundsGroup && this.boundsW === this.worldWidth && this.boundsH === this.worldHeight) {
      return;
    }
    // Tear down a stale shore (different lake size) before rebuilding.
    if (this.boundsGroup) {
      this.scene.remove(this.boundsGroup);
      for (const d of this.boundsDisposables) {
        d.dispose();
      }
      this.boundsDisposables = [];
    }

    const W = this.worldWidth;
    const H = this.worldHeight;
    const g = new THREE.Group();

    // A sloped shore ringing the whole lake — sandy at the waterline, rising
    // through a beach and bank to a wide grassy plain that runs out to the fogged
    // horizon, so the play area reads as a real lake instead of a glass box.
    const geo = this.buildShoreGeometry(W, H);
    this.boundsDisposables.push(geo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    this.boundsDisposables.push(mat);
    g.add(new THREE.Mesh(geo, mat));

    this.boundsGroup = g;
    this.boundsW = W;
    this.boundsH = H;
    this.scene.add(g);
  }

  // Concentric rectangular rings around the lake [0,W]x[0,H]: the inner ring sits
  // at the waterline (sand just awash), rising through a beach and bank to a wide
  // grassy plain reaching past the fog. Sandy near the water, grassy higher up.
  private buildShoreGeometry(W: number, H: number): THREE.BufferGeometry {
    const offsets = [0, 0.7, 2.2, 9, 90];
    const heights = [-0.1, 0.12, 0.55, 1.3, 1.7];
    const jitter = [0, 0.18, 0.4, 0.55, 0];
    const seg = 16; // sample points per rectangle edge
    const sand = new THREE.Color('#d8c68f');
    const grass = new THREE.Color('#6f9350');
    const peak = 1.7;

    // Perimeter points for the lake rectangle expanded outward by d, as a loop.
    const ringPts = (d: number): { x: number; z: number }[] => {
      const x0 = -d;
      const x1 = W + d;
      const z0 = -d;
      const z1 = H + d;
      const pts: { x: number; z: number }[] = [];
      const edge = (ax: number, az: number, bx: number, bz: number) => {
        for (let i = 0; i < seg; i++) {
          const u = i / seg;
          pts.push({ x: ax + (bx - ax) * u, z: az + (bz - az) * u });
        }
      };
      edge(x0, z0, x1, z0);
      edge(x1, z0, x1, z1);
      edge(x1, z1, x0, z1);
      edge(x0, z1, x0, z0);
      return pts;
    };

    const rings = offsets.map(ringPts);
    const n = rings[0].length;
    const positions: number[] = [];
    const colors: number[] = [];
    const ringStart: number[] = [];
    for (let ri = 0; ri < rings.length; ri++) {
      ringStart.push(positions.length / 3);
      const jf = jitter[ri];
      for (let j = 0; j < n; j++) {
        const p = rings[ri][j];
        // Deterministic wobble so the bank isn't a perfectly straight rectangle.
        const y = heights[ri] + (jf ? (this.hashNoise(ri * 131 + j) - 0.5) * jf : 0);
        positions.push(p.x, y, p.z);
        const tt = THREE.MathUtils.clamp(heights[ri] / peak, 0, 1);
        const col = sand.clone().lerp(grass, THREE.MathUtils.smoothstep(tt, 0.05, 0.5));
        colors.push(col.r, col.g, col.b);
      }
    }

    const indices: number[] = [];
    for (let ri = 0; ri < rings.length - 1; ri++) {
      const a = ringStart[ri];
      const b = ringStart[ri + 1];
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        indices.push(a + j, a + j2, b + j2);
        indices.push(a + j, b + j2, b + j);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // Cheap deterministic 0..1 hash for static shoreline wobble.
  private hashNoise(i: number): number {
    const s = Math.sin(i * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  // Reshape the wake ribbon along the player's recent path and fade it in/out
  // with speed. Called every frame from update().
  private updateWake(dt: number, boatPos: THREE.Vector3, headRad: number, t: number): void {
    if (!this.wake || !this.wakeGeo || !this.wakeAlpha) {
      return;
    }
    // Stern point: a little behind the hull centre along its heading.
    const fx = Math.cos(headRad);
    const fz = Math.sin(headRad);
    const sternX = boatPos.x - fx * 1.1;
    const sternZ = boatPos.z - fz * 1.1;
    // Perpendicular to the heading (on the water plane) — the crests spread along it.
    const perpX = -fz;
    const perpZ = fx;

    const pts = this.wakePts;

    // Smooth the hull speed (units/sec) from the stern's frame-to-frame motion.
    if (this.wakePrevStern) {
      const md = Math.hypot(sternX - this.wakePrevStern.x, sternZ - this.wakePrevStern.z);
      // A big jump is a teleport (respawn / lake change): wipe the trail so no
      // wave streaks across the map.
      if (md > this.TELEPORT_SNAP_DIST) {
        pts.length = 0;
        this.wakeSpeed = 0;
        this.wakePrevStern = { x: sternX, z: sternZ };
        if (this.bowWave) {
          (this.bowWave.material as THREE.MeshBasicMaterial).opacity = 0;
        }
      } else {
        const inst = dt > 0 ? md / dt : 0;
        this.wakeSpeed += (inst - this.wakeSpeed) * (1 - Math.exp(-6 * dt));
      }
    }
    this.wakePrevStern = { x: sternX, z: sternZ };

    // Emit a fresh crest point when the stern has moved a spacing's worth AND the
    // boat is actually making way (so a drifting/parked boat leaves no wake).
    const last = pts.length ? pts[pts.length - 1] : null;
    const movedFromLast = last ? Math.hypot(sternX - last.x, sternZ - last.z) : Infinity;
    if (this.wakeSpeed > 0.35 && movedFromLast >= this.WAKE_SPACING) {
      pts.push({ x: sternX, z: sternZ, px: perpX, pz: perpZ, born: t });
    }
    // Age out expired crests (oldest first) and cap the count.
    while (pts.length && t - pts[0].born > this.WAKE_LIFE) {
      pts.shift();
    }
    while (pts.length > this.WAKE_MAX) {
      pts.shift();
    }

    // Rebuild both diverging arms from the live crest points.
    const pos = this.wakeGeo.attributes['position'].array as Float32Array;
    const alpha = this.wakeAlpha;
    const N = this.WAKE_MAX;
    const n = pts.length;
    for (let i = 0; i < N; i++) {
      const row = i * 4;
      if (i >= n) {
        // Unused row: collapse it onto the newest point with zero alpha.
        const p = n ? pts[n - 1] : null;
        const cx = p ? p.x : sternX;
        const cz = p ? p.z : sternZ;
        const y = this.waveHeight(cx, cz, t) + 0.08;
        for (let k = 0; k < 4; k++) {
          pos[(row + k) * 3] = cx;
          pos[(row + k) * 3 + 1] = y;
          pos[(row + k) * 3 + 2] = cz;
          alpha[row + k] = 0;
        }
        continue;
      }
      const p = pts[i];
      const age = t - p.born;
      const lifeT = this.clamp01(age / this.WAKE_LIFE);
      // Fade in briefly at birth, then dissolve toward the end of life.
      const fade = Math.min(1, lifeT / 0.08) * (1 - lifeT) * (1 - lifeT);
      const a = fade * Math.min(1, Math.max(0, (this.wakeSpeed - 0.2) / 1.6)) * 0.95;
      // Crests fan outward as they age (the diverging Kelvin arms).
      const spread = this.WAKE_BASE_HALF + age * this.WAKE_SPREAD;
      const th = this.WAKE_THICK;
      // Left arm: inner/outer edges of the crest band at +perp*spread.
      const lIn = spread - th;
      const lOut = spread + th;
      const lInX = p.x + p.px * lIn, lInZ = p.z + p.pz * lIn;
      const lOutX = p.x + p.px * lOut, lOutZ = p.z + p.pz * lOut;
      // Right arm at -perp*spread.
      const rInX = p.x - p.px * lIn, rInZ = p.z - p.pz * lIn;
      const rOutX = p.x - p.px * lOut, rOutZ = p.z - p.pz * lOut;
      const set = (slot: number, x: number, z: number) => {
        const o = (row + slot) * 3;
        pos[o] = x;
        pos[o + 1] = this.waveHeight(x, z, t) + 0.08;
        pos[o + 2] = z;
        alpha[row + slot] = a;
      };
      set(0, lInX, lInZ);
      set(1, lOutX, lOutZ);
      set(2, rInX, rInZ);
      set(3, rOutX, rOutZ);
    }
    this.wakeGeo.attributes['position'].needsUpdate = true;
    this.wakeGeo.attributes['aAlpha'].needsUpdate = true;

    // Bow wave: sit the moustache quad so its stem lands at the bow, aimed along
    // the heading, growing with speed and sweeping foam back along the hull.
    if (this.bowWave) {
      const grow = Math.min(1.4, 0.5 + this.wakeSpeed * 0.25);
      const scaleZ = 3.0 * grow;
      // Place the quad centre so its forward (+Z) edge reaches ~the bow (1.2 ahead
      // of the hull centre); arms then trail back alongside the hull.
      const centreFwd = 1.2 - scaleZ / 2;
      const bx = boatPos.x + fx * centreFwd;
      const bz = boatPos.z + fz * centreFwd;
      const by = this.waveHeight(bx, bz, t) + 0.09;
      this.bowWave.position.set(bx, by, bz);
      this.bowWave.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(fx, 0, fz),
      );
      this.bowWave.scale.set(2.2 * grow, 1, scaleZ);
      const bowMat = this.bowWave.material as THREE.MeshBasicMaterial;
      const bowTarget = Math.max(0, Math.min(0.85, (this.wakeSpeed - 0.3) / 2.4));
      bowMat.opacity += (bowTarget - bowMat.opacity) * (1 - Math.exp(-5 * dt));
    }
  }

  // A field of short line "streaks" drifting downwind around the player so the
  // wind direction is visible in 3D (they stream toward `windDirection`, i.e.
  // away from where the wind blows from).
  private ensureWindStreaks(): void {
    if (this.windStreaks || !this.scene) {
      return;
    }
    const n = this.WIND_COUNT;
    const half = this.WIND_BOX / 2;
    this.windHeads = new Float32Array(n * 3);
    this.windPhase = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      this.windHeads[i * 3] = (Math.random() * 2 - 1) * half;
      this.windHeads[i * 3 + 1] = 0.5 + Math.random() * 4.5;
      this.windHeads[i * 3 + 2] = (Math.random() * 2 - 1) * half;
      this.windPhase[i * 2] = Math.random() * Math.PI * 2; // meander phase
      this.windPhase[i * 2 + 1] = 0.8 + Math.random() * 0.5; // speed jitter
    }
    this.windGeo = new THREE.BufferGeometry();
    this.windGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xf0f8ff, transparent: true, opacity: 0.34 });
    this.sharedMat.push(mat);
    this.windStreaks = new THREE.LineSegments(this.windGeo, mat);
    this.windStreaks.frustumCulled = false;
    this.scene.add(this.windStreaks);
  }

  private updateWindStreaks(dt: number, p: { x: number; y: number }, t: number): void {
    if (!this.windStreaks || !this.windGeo) {
      return;
    }
    const rad = (this.windDirection * Math.PI) / 180;
    // Fresh breeze: visible but calm drift, moderate streaks. Each gust wanders a
    // little to the side (a slowly varying heading) so they curl instead of
    // racing dead straight like hyperspace.
    const speed = 3 + this.windStrength * 0.7;
    const streak = 0.8 + this.windStrength * 0.13;
    const half = this.WIND_BOX / 2;
    const pos = this.windGeo.attributes['position'].array as Float32Array;
    const n = this.WIND_COUNT;
    for (let i = 0; i < n; i++) {
      const phase = this.windPhase[i * 2];
      const spd = speed * this.windPhase[i * 2 + 1];
      // Wander the local heading by up to ~0.35 rad off the wind axis.
      const ang = rad + Math.sin(t * 0.35 + phase) * 0.35;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      let hx = this.windHeads[i * 3] + dx * spd * dt;
      let hz = this.windHeads[i * 3 + 2] + dz * spd * dt;
      if (hx > half) hx -= this.WIND_BOX;
      else if (hx < -half) hx += this.WIND_BOX;
      if (hz > half) hz -= this.WIND_BOX;
      else if (hz < -half) hz += this.WIND_BOX;
      this.windHeads[i * 3] = hx;
      this.windHeads[i * 3 + 2] = hz;
      const hy = this.windHeads[i * 3 + 1];
      const wx = p.x + hx;
      const wz = p.y + hz;
      const j = i * 6;
      pos[j] = wx;
      pos[j + 1] = hy;
      pos[j + 2] = wz;
      pos[j + 3] = wx - dx * streak;
      pos[j + 4] = hy;
      pos[j + 5] = wz - dz * streak;
    }
    this.windGeo.attributes['position'].needsUpdate = true;
  }

  private update(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }
    const t = this.clock.getElapsedTime();
    // Real elapsed time since the last frame, used for every frame-rate
    // independent smoothing step below (boat interpolation, camera, wind).
    const dt = this.lastTime ? Math.min(0.05, t - this.lastTime) : 0.016;
    this.lastTime = t;

    this.ensureIslands();
    this.ensureWorldBounds();
    this.ensureWindStreaks();
    this.syncBoats(t, dt);
    this.syncBuoys(t);
    this.syncProjectiles(t);

    // Recentre the water on the player and displace its vertices for real waves.
    const p = this.playerPos();
    if (this.water && this.waterGeo) {
      this.water.position.set(p.x, 0, p.y);
      const pos = this.waterGeo.attributes['position'] as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const lx = this.waterBaseZ[i];
        const lz = this.waterBaseZ[i + 2];
        arr[i + 1] = this.waveHeight(lx + p.x, lz + p.y, t);
      }
      pos.needsUpdate = true;
      this.waterGeo.computeVertexNormals();
    }
    // Keep the sky dome centred on the player so the horizon ring never drifts.
    if (this.sky) {
      this.sky.position.set(p.x, 0, p.y);
    }

    // Third-person chase camera: sit just astern of the player and above the
    // deck, turning WITH the boat's heading (like the skipper's own view), so
    // steering left swings the whole world left. The boat stays centred.
    // Third-person chase camera locked astern of the player and turning WITH the
    // boat's heading, so the boat stays dead-centre in the frame. We read the
    // boat mesh's own (smoothed) position/heading so the target can never snap
    // independently of what's drawn.
    const player = this.playerBoatId ? this.boats.find((b) => b.boatId === this.playerBoatId) : undefined;
    const boatMesh = this.playerBoatId ? this.boatMeshes.get(this.playerBoatId) : undefined;
    const playerDisp = this.playerBoatId ? this.boatDisplay.get(this.playerBoatId) : undefined;
    const h = playerDisp ? playerDisp.headRad : ((player ? player.heading : 90) * Math.PI) / 180;
    const boatPos = boatMesh ? boatMesh.position : new THREE.Vector3(p.x, this.waveHeight(p.x, p.y, t), p.y);
    const camDist = 11;
    const camHeight = 5.6;

    // Advance the manual orbit (9 / 0 keys) using real elapsed time.
    this.orbit += this.orbitDir * this.ORBIT_SPEED * dt;

    // Drift the wind streaks downwind around the player.
    this.updateWindStreaks(dt, p, t);

    // Trail the foam wake behind the player along its recent path.
    this.updateWake(dt, boatPos, h, t);

    // Ease the camera azimuth toward the boat's heading so it trails the turn
    // with a gentle lag. Frame-rate independent exponential smoothing, resolving
    // the shortest way around the circle so it never spins the long way.
    const targetYaw = h + this.orbit;
    if (this.camYaw === null) {
      this.camYaw = targetYaw;
    } else {
      let delta = targetYaw - this.camYaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // ~3.5 rad/s response: smooth but still keeps up with normal steering.
      this.camYaw += delta * (1 - Math.exp(-3.5 * dt));
    }

    // View direction from the boat: astern of the smoothed heading.
    const viewAng = this.camYaw + Math.PI;
    const off = new THREE.Vector3(Math.cos(viewAng), 0, Math.sin(viewAng));
    const desired = new THREE.Vector3(
      boatPos.x + off.x * camDist,
      boatPos.y + camHeight,
      boatPos.z + off.z * camDist,
    );
    const lookTarget = new THREE.Vector3(boatPos.x, boatPos.y + 1.9, boatPos.z);

    if (!this.camReady) {
      this.camera.position.copy(desired);
      this.camLook.copy(lookTarget);
      this.camReady = true;
    } else {
      // Smooth position and the look target together so both the framing and the
      // pan stay fluid rather than locking rigidly to the (noisy) boat mesh.
      const posK = 1 - Math.exp(-6 * dt);
      const lookK = 1 - Math.exp(-8 * dt);
      this.camera.position.lerp(desired, posK);
      this.camLook.lerp(lookTarget, lookK);
    }
    this.camera.lookAt(this.camLook);

    this.renderer.render(this.scene, this.camera);
    this.drawCompass(player);
  }
}
