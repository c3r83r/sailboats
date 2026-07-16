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

  // Kielwater (wake): a foam ribbon trailing the player, rebuilt each frame from
  // a short rolling history of stern positions.
  private wake?: THREE.Mesh;
  private wakeGeo?: THREE.BufferGeometry;
  private wakeTex?: THREE.CanvasTexture;
  private wakeTrail: { x: number; y: number }[] = [];
  private wakeSpeed = 0; // smoothed hull speed (scene units/sec) driving foam opacity
  private readonly WAKE_POINTS = 48;

  // Per-id mesh pools so we add/remove/update meshes as the sim changes.
  private boatMeshes = new Map<string, THREE.Group>();
  private islandMeshes = new Map<string, THREE.Mesh>();
  private projectileMeshes = new Map<string, THREE.Mesh>();
  private buoyMeshes = new Map<string, THREE.Group>();
  private lastIslandsRef: Island[] | null = null;

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
  private glassTex?: THREE.CanvasTexture;
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
    this.glassTex?.dispose();
    this.wakeGeo?.dispose();
    this.wakeTex?.dispose();
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

  // Kielwater (wake): a tapering foam ribbon that trails the player. The geometry
  // is a two-vertex-wide strip whose rows are re-placed along the boat's recent
  // path every frame; the foam texture bakes in the soft edges and the fade to
  // clear water at the tail, and the whole ribbon fades out when the boat slows.
  private buildWake(): void {
    const P = this.WAKE_POINTS;
    this.wakeGeo = new THREE.BufferGeometry();
    this.wakeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 2 * 3), 3));
    const uv = new Float32Array(P * 2 * 2);
    for (let i = 0; i < P; i++) {
      const v = i / (P - 1); // 0 at the tail, 1 at the boat
      uv[(i * 2) * 2] = 0;
      uv[(i * 2) * 2 + 1] = v;
      uv[(i * 2 + 1) * 2] = 1;
      uv[(i * 2 + 1) * 2 + 1] = v;
    }
    this.wakeGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx: number[] = [];
    for (let i = 0; i < P - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.wakeGeo.setIndex(idx);
    this.wakeTex = this.makeWakeTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: this.wakeTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.sharedMat.push(mat);
    this.wake = new THREE.Mesh(this.wakeGeo, mat);
    this.wake.frustumCulled = false;
    this.wake.renderOrder = 2; // draw over the (transparent) water
    this.scene?.add(this.wake);
  }

  // Foam texture for the wake: white, with soft feathered side edges (u) and a
  // lengthwise fade from turbulent near the boat (v=1) to clear at the tail
  // (v=0), broken up by speckle so it reads as churned foam not a flat stripe.
  private makeWakeTexture(): THREE.CanvasTexture {
    const W = 64;
    const H = 128;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1); // 0 tail, 1 boat  (flipY disabled below)
      const lenFade = Math.pow(v, 0.85); // strong near the boat, gone at the tail
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.sin(Math.PI * u); // 0 at the sides, 1 in the middle
        const edgeFade = Math.pow(edge, 0.7);
        // Broken foam: coarse speckle plus a couple of drifting ripples.
        const speckle = 0.55 + 0.45 * Math.random();
        const ripple = 0.8 + 0.2 * Math.sin(v * 26 + u * 7);
        const a = Math.max(0, Math.min(1, edgeFade * lenFade * speckle * ripple));
        const i = (y * W + x) * 4;
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = Math.round(a * 235);
      }
    }
    ctx.putImageData(img, 0, 0);
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

    return grp;
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

    // Anchor rig (toggled when the boat is anchored): a rode from the bow down to
    // a small anchor resting just under the surface ahead of the boat. Lives on
    // the hull group (not the rig) so it does not heel.
    const anchor = this.makeAnchor();
    anchor.name = 'anchor';
    anchor.visible = false;
    group.add(anchor);

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

  private makeAnchor(): THREE.Group {
    const grp = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2c3038'), roughness: 0.42, metalness: 0.8 });
    this.sharedMat.push(mat);
    // Local frame: the anchor is stowed at the bow, shank vertical (+Y up) with
    // the stock across Z and the crown/flukes at the bottom.
    const base = new THREE.Vector3(1.6, 0.14, 0);

    // Rode (chain) from the bow roller down to the shackle.
    const rodeMat = new THREE.LineBasicMaterial({ color: 0x1b1e23 });
    this.sharedMat.push(rodeMat);
    const rodeGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(1.36, 0.44, 0),
      new THREE.Vector3(base.x, base.y + 0.56, 0),
    ]);
    this.sharedGeo.push(rodeGeo);
    grp.add(new THREE.Line(rodeGeo, rodeMat));

    // Shackle ring at the top of the shank.
    const ringGeo = new THREE.TorusGeometry(0.1, 0.028, 8, 16);
    this.sharedGeo.push(ringGeo);
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.position.set(base.x, base.y + 0.58, 0);
    ring.rotation.y = Math.PI / 2;
    grp.add(ring);

    // Shank: the main vertical bar.
    const shankGeo = new THREE.CylinderGeometry(0.045, 0.052, 0.86, 8);
    this.sharedGeo.push(shankGeo);
    const shank = new THREE.Mesh(shankGeo, mat);
    shank.position.set(base.x, base.y + 0.14, 0);
    grp.add(shank);

    // Stock: the crossbar near the top (along Z) with rounded ends.
    const stockGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.66, 6);
    stockGeo.rotateX(Math.PI / 2);
    this.sharedGeo.push(stockGeo);
    const stock = new THREE.Mesh(stockGeo, mat);
    stock.position.set(base.x, base.y + 0.44, 0);
    grp.add(stock);
    const knobGeo = new THREE.SphereGeometry(0.05, 8, 6);
    this.sharedGeo.push(knobGeo);
    for (const z of [-0.33, 0.33]) {
      const k = new THREE.Mesh(knobGeo, mat);
      k.position.set(base.x, base.y + 0.44, z);
      grp.add(k);
    }

    // Curved crown/arms: a half-torus bowl opening upward at the base.
    const crownGeo = new THREE.TorusGeometry(0.3, 0.05, 8, 22, Math.PI);
    this.sharedGeo.push(crownGeo);
    const crown = new THREE.Mesh(crownGeo, mat);
    crown.position.set(base.x, base.y - 0.3, 0);
    crown.rotation.z = Math.PI; // flip the arc into a ∪ bowl
    grp.add(crown);

    // Triangular flukes (barbs) at each arm tip.
    const flukeGeo = new THREE.ConeGeometry(0.12, 0.3, 4);
    this.sharedGeo.push(flukeGeo);
    const armTip = 0.3;
    const leftFluke = new THREE.Mesh(flukeGeo, mat);
    leftFluke.position.set(base.x - armTip, base.y - 0.22, 0);
    leftFluke.rotation.z = 0.9;
    grp.add(leftFluke);
    const rightFluke = new THREE.Mesh(flukeGeo, mat);
    rightFluke.position.set(base.x + armTip, base.y - 0.22, 0);
    rightFluke.rotation.z = -0.9;
    grp.add(rightFluke);

    return grp;
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
        this.boatMeshes.set(boat.boatId, g);
      }

      // Smooth the boat's ground-plane position toward the latest server value.
      let disp = this.boatDisplay.get(boat.boatId);
      if (!disp) {
        disp = { x: boat.x, y: boat.y, headRad: (boat.heading * Math.PI) / 180 };
        this.boatDisplay.set(boat.boatId, disp);
      } else {
        disp.x += (boat.x - disp.x) * posK;
        disp.y += (boat.y - disp.y) * posK;
        const targetHead = (boat.heading * Math.PI) / 180;
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

      const anchor = g.getObjectByName('anchor');
      if (anchor) {
        anchor.visible = !!boat.anchored && !boat.capsized && !boat.sunk;
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
    }

    // Remove meshes (and display state) for boats that left.
    for (const [id, g] of this.boatMeshes) {
      if (!seen.has(id)) {
        this.scene?.remove(g);
        this.boatMeshes.delete(id);
        this.boatDisplay.delete(id);
      }
    }
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
    // Tear down a stale fence (different lake size) before rebuilding.
    if (this.boundsGroup) {
      this.scene.remove(this.boundsGroup);
      for (const d of this.boundsDisposables) {
        d.dispose();
      }
      this.boundsDisposables = [];
    }

    const W = this.worldWidth;
    const H = this.worldHeight;
    const wallH = 3.0;
    const g = new THREE.Group();
    const glass = this.getGlassTexture();

    // One glass sheet per edge. Each wall clones the shared crack texture so it
    // can repeat at its own length while keeping the shards roughly square.
    const mkWall = (len: number, x: number, z: number, ry: number) => {
      const geo = new THREE.PlaneGeometry(len, wallH);
      this.boundsDisposables.push(geo);
      const tex = glass.clone();
      tex.needsUpdate = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(Math.max(1, Math.round(len / wallH)), 1);
      this.boundsDisposables.push(tex);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xcfe9ff,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.boundsDisposables.push(mat);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, wallH / 2, z);
      m.rotation.y = ry;
      g.add(m);
    };
    mkWall(W, W / 2, 0, 0);
    mkWall(W, W / 2, H, 0);
    mkWall(H, 0, H / 2, Math.PI / 2);
    mkWall(H, W, H / 2, Math.PI / 2);

    // Icy top rim and a faint waterline edge to give the glass a defined border.
    const corners = (y: number) => [
      new THREE.Vector3(0, y, 0),
      new THREE.Vector3(W, y, 0),
      new THREE.Vector3(W, y, H),
      new THREE.Vector3(0, y, H),
    ];
    const topGeo = new THREE.BufferGeometry().setFromPoints(corners(wallH));
    const botGeo = new THREE.BufferGeometry().setFromPoints(corners(0.05));
    this.boundsDisposables.push(topGeo, botGeo);
    const topMat = new THREE.LineBasicMaterial({ color: 0xd8f6ff, transparent: true, opacity: 0.85 });
    const botMat = new THREE.LineBasicMaterial({ color: 0x8fd6ff, transparent: true, opacity: 0.5 });
    this.boundsDisposables.push(topMat, botMat);
    g.add(new THREE.LineLoop(topGeo, topMat));
    g.add(new THREE.LineLoop(botGeo, botMat));

    this.boundsGroup = g;
    this.boundsW = W;
    this.boundsH = H;
    this.scene.add(g);
  }

  // A shattered-glass texture: a translucent frosted tint overlaid with several
  // impact points, each spraying radial cracks joined by concentric shard rings.
  private getGlassTexture(): THREE.CanvasTexture {
    if (this.glassTex) {
      return this.glassTex;
    }
    const S = 256;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    // Faint frosted panes so the glass reads even away from the cracks.
    ctx.fillStyle = 'rgba(200, 228, 248, 0.05)';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = `rgba(220, 240, 255, ${0.02 + Math.random() * 0.03})`;
      const w = 40 + Math.random() * 120;
      const h = 40 + Math.random() * 120;
      ctx.fillRect(Math.random() * S, Math.random() * S, w, h);
    }

    const impacts = [
      { x: S * 0.28, y: S * 0.42 },
      { x: S * 0.68, y: S * 0.3 },
      { x: S * 0.52, y: S * 0.72 },
    ];
    for (const imp of impacts) {
      const spokes = 8 + Math.floor(Math.random() * 5);
      const angs: number[] = [];
      for (let k = 0; k < spokes; k++) {
        angs.push((k / spokes) * Math.PI * 2 + Math.random() * 0.3);
      }
      // Radial cracks streaking out from the impact, thinning as they go.
      for (const a of angs) {
        const len = 40 + Math.random() * 90;
        let x = imp.x;
        let y = imp.y;
        ctx.beginPath();
        ctx.moveTo(x, y);
        const segs = 4;
        for (let s = 1; s <= segs; s++) {
          const jitter = (Math.random() - 0.5) * 0.25;
          x += Math.cos(a + jitter) * (len / segs);
          y += Math.sin(a + jitter) * (len / segs);
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.25 + Math.random() * 0.35})`;
        ctx.lineWidth = 0.6 + Math.random() * 1.2;
        ctx.stroke();
      }
      // Concentric shard rings linking neighbouring spokes into glass fragments.
      for (let r = 12; r < 90; r += 14 + Math.random() * 12) {
        ctx.beginPath();
        for (let k = 0; k <= spokes; k++) {
          const a = angs[k % spokes];
          const rr = r * (0.8 + Math.random() * 0.4);
          const x = imp.x + Math.cos(a) * rr;
          const y = imp.y + Math.sin(a) * rr;
          if (k === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = `rgba(230, 246, 255, ${0.12 + Math.random() * 0.2})`;
        ctx.lineWidth = 0.5 + Math.random() * 0.8;
        ctx.stroke();
      }
      // A bright pinch of highlight at the impact core.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.beginPath();
      ctx.arc(imp.x, imp.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    this.glassTex = tex;
    return tex;
  }

  // Reshape the wake ribbon along the player's recent path and fade it in/out
  // with speed. Called every frame from update().
  private updateWake(dt: number, boatPos: THREE.Vector3, headRad: number, t: number): void {
    if (!this.wake || !this.wakeGeo) {
      return;
    }
    const mat = this.wake.material as THREE.MeshBasicMaterial;
    // Stern point: a little behind the hull centre along its heading.
    const fx = Math.cos(headRad);
    const fz = Math.sin(headRad);
    const sternX = boatPos.x - fx * 1.1;
    const sternZ = boatPos.z - fz * 1.1;

    const trail = this.wakeTrail;
    if (trail.length === 0) {
      for (let i = 0; i < this.WAKE_POINTS; i++) {
        trail.push({ x: sternX, y: sternZ });
      }
    }
    const head = trail[trail.length - 1];
    const moved = Math.hypot(sternX - head.x, sternZ - head.y);
    // Smooth the hull speed (units/sec) that drives foam opacity.
    const inst = dt > 0 ? moved / dt : 0;
    this.wakeSpeed += (inst - this.wakeSpeed) * (1 - Math.exp(-6 * dt));
    // Drop a new trail point once the stern has moved far enough, so the ribbon
    // keeps a roughly even spacing regardless of frame rate.
    if (moved > 0.35) {
      trail.push({ x: sternX, y: sternZ });
      while (trail.length > this.WAKE_POINTS) {
        trail.shift();
      }
    } else {
      head.x = sternX;
      head.y = sternZ;
    }

    const P = this.WAKE_POINTS;
    const pos = this.wakeGeo.attributes['position'].array as Float32Array;
    for (let i = 0; i < P; i++) {
      // Map trail (oldest->newest) onto rows, padding the tail if it is short.
      const ti = trail.length - P + i;
      const cur = trail[ti >= 0 ? ti : 0];
      const nxt = trail[Math.min(trail.length - 1, (ti >= 0 ? ti : 0) + 1)];
      let dx = nxt.x - cur.x;
      let dz = nxt.y - cur.y;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      // Perpendicular to the local path direction (on the water plane).
      const px = -dz;
      const pz = dx;
      const v = i / (P - 1); // 0 tail, 1 boat
      // Wakes are narrow at the transom and fan out astern; taper accordingly.
      const halfW = 0.5 + (1 - v) * 2.6;
      const cx = cur.x;
      const cz = cur.y;
      const y = this.waveHeight(cx, cz, t) + 0.07;
      const a = i * 2 * 3;
      const b = (i * 2 + 1) * 3;
      pos[a] = cx + px * halfW;
      pos[a + 1] = y;
      pos[a + 2] = cz + pz * halfW;
      pos[b] = cx - px * halfW;
      pos[b + 1] = y;
      pos[b + 2] = cz - pz * halfW;
    }
    this.wakeGeo.attributes['position'].needsUpdate = true;
    this.wakeGeo.computeVertexNormals();
    // Fade the foam in with speed; invisible when nearly stopped.
    const target = Math.max(0, Math.min(0.9, (this.wakeSpeed - 0.4) / 3.2));
    mat.opacity += (target - mat.opacity) * (1 - Math.exp(-5 * dt));
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
