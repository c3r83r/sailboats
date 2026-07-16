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
  private readonly WATER_SIZE = 90;
  private readonly WATER_SEG = 72;

  // Per-id mesh pools so we add/remove/update meshes as the sim changes.
  private boatMeshes = new Map<string, THREE.Group>();
  private islandMeshes = new Map<string, THREE.Mesh>();
  private projectileMeshes = new Map<string, THREE.Mesh>();
  private buoyMeshes = new Map<string, THREE.Mesh>();
  private lastIslandsRef: Island[] | null = null;

  private sharedGeo: THREE.BufferGeometry[] = [];
  private sharedMat: THREE.Material[] = [];

  // Manual camera orbit around the boat, driven by the 9 / 0 keys.
  private orbit = 0; // azimuth offset (radians) added to the astern view
  private orbitDir = 0; // -1 / 0 / +1 while a key is held
  private readonly ORBIT_SPEED = 1.8; // radians per second
  private lastTime = 0;
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

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#8fc4e6');
    this.scene.fog = new THREE.Fog('#8fc4e6', 55, 130);

    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 400);
    this.camera.position.set(0, 24, 20);

    // Lighting: soft sky/ground fill plus an angled sun for shape and shadows.
    const hemi = new THREE.HemisphereLight(0xdff1ff, 0x1e4258, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.15);
    sun.position.set(-30, 45, -18);
    this.scene.add(sun);

    this.buildWater();

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
    this.waterGeo?.dispose();
    this.renderer?.dispose();
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
  }

  // ---- world helpers ----------------------------------------------------

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

    const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#9c7d42'), roughness: 0.95 });
    const topMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#6f9350'), roughness: 1 });
    this.sharedMat.push(wallMat, topMat);

    let idx = 0;
    for (const island of this.islands) {
      if (!island.points || island.points.length < 3) {
        continue;
      }
      // Centroid + radius for a simple raised hill.
      let cx = 0;
      let cy = 0;
      for (const p of island.points) {
        cx += p.x;
        cy += p.y;
      }
      cx /= island.points.length;
      cy /= island.points.length;
      let r = 0;
      for (const p of island.points) {
        r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
      }

      // Build a flat-topped shape from the actual polygon, extruded up from the sea bed.
      const shape = new THREE.Shape();
      island.points.forEach((p, i) => {
        const lx = p.x - cx;
        const lz = p.y - cy;
        if (i === 0) {
          shape.moveTo(lx, lz);
        } else {
          shape.lineTo(lx, lz);
        }
      });
      shape.closePath();
      const height = Math.max(1.1, r * 0.5);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.4, bevelSegments: 2 });
      geo.rotateX(-Math.PI / 2); // shape was in XY; lay it on the ground, extrude up
      const mesh = new THREE.Mesh(geo, [wallMat, topMat]);
      mesh.position.set(cx, -0.2, cy);
      this.scene?.add(mesh);
      this.islandMeshes.set(island.id ?? `isl-${idx}`, mesh);
      idx++;
    }
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
    const nSt = 18; // stations along the length
    const nSec = 13; // points across each U-shaped section
    const xStern = -0.98;
    const xBow = 1.2;

    // Antila-33-style cruiser: beam carried well aft (wide stern), moderate
    // freeboard and a nearly plumb bow.
    const beamCtrl: [number, number][] = [[0, 0.4], [0.12, 0.44], [0.35, 0.48], [0.55, 0.485], [0.72, 0.46], [0.86, 0.34], [0.95, 0.16], [1, 0.03]];
    const beam = (t: number) => this.profile(beamCtrl, t);
    const deckY = (t: number) => 0.46 + 0.16 * Math.pow(t, 1.8) + 0.05 * Math.pow(1 - t, 2.2);
    // Shallow, rounded canoe body — the real draught comes from the fin keel below.
    const bottomY = (t: number) => -0.16 * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.82 + 0.12)));

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
    // Transom cap at the stern (fan from the ring centre).
    const stern = rings[0];
    const sc = new THREE.Vector3(xStern, (stern[0].y + stern[(nSec - 1) / 2 | 0].y) * 0.5, 0);
    for (let j = 0; j < nSec - 1; j++) {
      tri(sc, stern[j + 1], stern[j]);
    }

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
    const finGeo = new THREE.BoxGeometry(0.4, 0.62, 0.055);
    finGeo.translate(0, -0.31, 0);
    this.sharedGeo.push(finGeo);
    const fin = new THREE.Mesh(finGeo, keelMat);
    fin.position.set(0.22, -0.1, 0);
    grp.add(fin);
    const bulbGeo = new THREE.SphereGeometry(0.08, 10, 8);
    bulbGeo.scale(2.4, 0.85, 1.1);
    this.sharedGeo.push(bulbGeo);
    const bulb = new THREE.Mesh(bulbGeo, keelMat);
    bulb.position.set(0.22, -0.72, 0);
    grp.add(bulb);
    const rudGeo = new THREE.BoxGeometry(0.13, 0.44, 0.04);
    rudGeo.translate(0, -0.22, 0);
    this.sharedGeo.push(rudGeo);
    const rudder = new THREE.Mesh(rudGeo, keelMat);
    rudder.position.set(-0.82, -0.06, 0);
    grp.add(rudder);

    // Deck: pale non-skid deck spanning the port and starboard deck edges.
    const deck: number[] = [];
    for (let i = 0; i < nSt - 1; i++) {
      const p0 = rings[i][0];
      const p1 = rings[i + 1][0];
      const s0 = rings[i][nSec - 1];
      const s1 = rings[i + 1][nSec - 1];
      deck.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, s1.x, s1.y, s1.z);
      deck.push(p0.x, p0.y, p0.z, s1.x, s1.y, s1.z, s0.x, s0.y, s0.z);
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
    const cabW = 0.28; // half width
    const cabFront = 0.92;
    const cabAft = -0.28;
    const cshape = new THREE.Shape();
    const rr = 0.16;
    cshape.moveTo(cabAft, -cabW);
    cshape.lineTo(cabFront - rr, -cabW);
    cshape.quadraticCurveTo(cabFront, -cabW, cabFront, -cabW + rr);
    cshape.lineTo(cabFront, cabW - rr);
    cshape.quadraticCurveTo(cabFront, cabW, cabFront - rr, cabW);
    cshape.lineTo(cabAft, cabW);
    cshape.closePath();
    const cabGeo = new THREE.ExtrudeGeometry(cshape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 2 });
    cabGeo.rotateX(-Math.PI / 2);
    this.sharedGeo.push(cabGeo);
    const cabinMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#f4f3ee'), roughness: 0.5 });
    this.sharedMat.push(cabinMat);
    const cabin = new THREE.Mesh(cabGeo, cabinMat);
    const cabinBaseY = deckY(0.6) + 0.02;
    cabin.position.set(0.1, cabinBaseY, 0);
    grp.add(cabin);

    // Window band: a dark strip wrapping the cabin sides (tinted glazing).
    const winGeo = new THREE.BoxGeometry(1.02, 0.1, cabW * 2 + 0.06);
    this.sharedGeo.push(winGeo);
    const winMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#10141a'), roughness: 0.25, metalness: 0.3 });
    this.sharedMat.push(winMat);
    const windows = new THREE.Mesh(winGeo, winMat);
    windows.position.set(0.28, cabinBaseY + 0.16, 0);
    grp.add(windows);

    // Companionway hatch (dark opening at the aft end of the cabin).
    const hatchGeo = new THREE.BoxGeometry(0.22, 0.16, 0.34);
    this.sharedGeo.push(hatchGeo);
    const hatch = new THREE.Mesh(hatchGeo, winMat);
    hatch.position.set(-0.22, cabinBaseY + 0.14, 0);
    grp.add(hatch);

    // Cockpit sole: a recessed dark panel aft of the cabin.
    const cockGeo = new THREE.BoxGeometry(0.62, 0.06, 0.56);
    this.sharedGeo.push(cockGeo);
    const cockMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#5a4a34'), roughness: 0.9 });
    this.sharedMat.push(cockMat);
    const cockpit = new THREE.Mesh(cockGeo, cockMat);
    cockpit.position.set(-0.55, deckY(0.22) - 0.03, 0);
    grp.add(cockpit);

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

    // Mast: tall and slim.
    const mastMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#d8dde2'), roughness: 0.45, metalness: 0.4 });
    const mastGeo = new THREE.CylinderGeometry(0.028, 0.036, 2.75, 10);
    this.sharedGeo.push(mastGeo);
    this.sharedMat.push(mastMat);
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(0.25, 1.37, 0);
    rig.add(mast);

    // Boom: a spar along the foot of the mainsail, re-aimed every frame.
    const boomGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    boomGeo.rotateZ(Math.PI / 2); // lie along local X so we can re-aim it
    this.sharedGeo.push(boomGeo);
    const boom = new THREE.Mesh(boomGeo, mastMat);
    boom.name = 'boom';
    rig.add(boom);

    // Sail material (shared): soft canvas white, lit on both faces.
    const sailMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#f4f8ff'),
      roughness: 0.9,
      side: THREE.DoubleSide,
    });
    this.sharedMat.push(sailMat);

    // Mainsail (grot) and jib (fok): segmented planes whose vertices are placed
    // in rig-local space every frame so they belly under wind or flap when luffing.
    const main = this.makeSailMesh(sailMat, 6, 9);
    main.name = 'main';
    rig.add(main);

    const jib = this.makeSailMesh(sailMat, 5, 8);
    jib.name = 'jib';
    rig.add(jib);

    // Standing rigging (olinowanie stałe): forestay, backstay, cap shrouds and
    // spreaders. Fixed wires that hold the mast up; they heel with the boat.
    const mastHead = new THREE.Vector3(0.25, 2.6, 0);
    const hounds = new THREE.Vector3(0.25, 1.9, 0);
    const bowTack = new THREE.Vector3(1.15, 0.2, 0);
    const stern = new THREE.Vector3(-0.95, 0.36, 0);
    const chainPort = new THREE.Vector3(0.12, 0.34, 0.44);
    const chainStbd = new THREE.Vector3(0.12, 0.34, -0.44);
    const spreadPort = new THREE.Vector3(0.25, 1.88, 0.28);
    const spreadStbd = new THREE.Vector3(0.25, 1.88, -0.28);

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
    spreaders.position.set(0.25, 1.88, 0);
    rig.add(spreaders);

    // Roller-furling foil + furled cloth on the forestay: a cylinder along the
    // stay whose radius grows as the jib rolls away (thin foil when fully unfurled).
    const furlDir = mastHead.clone().sub(bowTack);
    const furlLen = furlDir.length();
    const furlGeo = new THREE.CylinderGeometry(1, 1, furlLen, 8);
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
      // Belly bulges to leeward, fullest low and mid-chord, tapering to the head.
      const camber = belly * Math.sin(Math.PI * u) * (1 - 0.45 * v);
      const flap = flutter * Math.sin(u * 6.2 + v * 3.1 + phase * 9) * (0.3 + 0.7 * u);
      p.z += leewardSign * camber + flap;
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private makeAnchor(): THREE.Group {
    const grp = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3b4048'), roughness: 0.5, metalness: 0.6 });
    this.sharedMat.push(mat);
    // Hung at the bow roller just above the waterline so it reads clearly.
    const anchorPos = new THREE.Vector3(1.5, 0.05, 0);

    // Rode (chain) from the bow fitting down to the anchor stock.
    const rodeMat = new THREE.LineBasicMaterial({ color: 0x20242a });
    this.sharedMat.push(rodeMat);
    const rodeGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(1.15, 0.35, 0),
      new THREE.Vector3(anchorPos.x, anchorPos.y + 0.3, 0),
    ]);
    this.sharedGeo.push(rodeGeo);
    grp.add(new THREE.Line(rodeGeo, rodeMat));

    // Anchor: a shank, a stock across the top and a curved crown with flukes.
    const shankGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 6);
    this.sharedGeo.push(shankGeo);
    const shank = new THREE.Mesh(shankGeo, mat);
    shank.position.copy(anchorPos);
    grp.add(shank);

    const ringGeo = new THREE.TorusGeometry(0.09, 0.03, 6, 12);
    this.sharedGeo.push(ringGeo);
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.position.set(anchorPos.x, anchorPos.y + 0.32, 0);
    ring.rotation.y = Math.PI / 2;
    grp.add(ring);

    const stockGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6);
    stockGeo.rotateX(Math.PI / 2);
    this.sharedGeo.push(stockGeo);
    const stock = new THREE.Mesh(stockGeo, mat);
    stock.position.set(anchorPos.x, anchorPos.y + 0.16, 0);
    grp.add(stock);

    const crownGeo = new THREE.TorusGeometry(0.22, 0.045, 6, 14, Math.PI);
    this.sharedGeo.push(crownGeo);
    const crown = new THREE.Mesh(crownGeo, mat);
    crown.position.set(anchorPos.x, anchorPos.y - 0.32, 0);
    grp.add(crown);

    return grp;
  }

  private syncBoats(t: number): void {
    const seen = new Set<string>();
    for (const boat of this.boats) {
      seen.add(boat.boatId);
      let g = this.boatMeshes.get(boat.boatId);
      if (!g) {
        g = this.makeBoat();
        g.scale.setScalar(1.3);
        this.boatMeshes.set(boat.boatId, g);
      }

      // Float the boat on the wave surface at its position.
      const wy = this.waveHeight(boat.x, boat.y, t);
      g.position.set(boat.x, wy, boat.y);

      // Heel the WHOLE boat (hull + rig) around its forward axis: yaw to the
      // heading, then roll to the heel angle. Eased for smoothness.
      const capsized = !!boat.capsized;
      const heelDeg = capsized ? 82 * Math.sign(boat.heel || 1) : boat.heel ?? 0;
      const targetRoll = (heelDeg * Math.PI) / 180;
      const curRoll = (g.userData['heelRad'] as number) ?? 0;
      const heelRad = curRoll + (targetRoll - curRoll) * 0.15;
      g.userData['heelRad'] = heelRad;
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(boat.heading * Math.PI) / 180);
      const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), heelRad);
      g.quaternion.copy(yaw).multiply(roll);

      const rig = g.getObjectByName('rig') as THREE.Group | undefined;
      if (rig) {
        this.updateRig(boat, rig, heelDeg, capsized, t);
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

    // Remove meshes for boats that left.
    for (const [id, g] of this.boatMeshes) {
      if (!seen.has(id)) {
        this.scene?.remove(g);
        this.boatMeshes.delete(id);
      }
    }
  }

  // Reshape both sails, aim the boom, and toggle rig visibility for one boat.
  private updateRig(boat: BoatState, rig: THREE.Group, heelDeg: number, capsized: boolean, t: number): void {
    const player = boat.boatId === this.playerBoatId;
    const c: HelmControlState | null = player ? this.controls : null;

    // Deploy / sheet: the player has a detailed helm; other boats only report a
    // single sailTrim, so we derive plausible values from it.
    const trim = boat.sailTrim ?? 0;
    const mainDeploy = c ? this.clamp01(c.main.deploy) : trim > 0.04 ? this.clamp01(0.45 + trim) : 0;
    const mainSheet = c ? this.clamp01(c.main.sheet) : trim;
    const jibDeploy = c ? this.clamp01(c.jib.deploy) : trim > 0.04 ? this.clamp01(0.35 + trim) : 0;
    const jibSheet = c ? this.clamp01(c.jib.sheet) : trim;

    // Luffing: the player exposes explicit sail state; for others a sail that is
    // hoisted while the boat sits bolt upright is effectively head-to-wind.
    const mainLuff = player ? this.mainState === 'luff' || this.mainState === 'down' : Math.abs(heelDeg) < 3 && mainDeploy > 0;
    const jibLuff = player ? this.jibState === 'luff' || this.jibState === 'down' : Math.abs(heelDeg) < 3 && jibDeploy > 0;

    const lee = heelDeg >= 0 ? 1 : -1;
    const gust = this.clamp(this.windStrength / 5, 0.6, 1.6);

    const main = rig.getObjectByName('main') as THREE.Mesh | undefined;
    const boom = rig.getObjectByName('boom') as THREE.Mesh | undefined;
    const jib = rig.getObjectByName('jib') as THREE.Mesh | undefined;
    const mainSheetLine = rig.getObjectByName('mainSheet') as THREE.Line | undefined;
    const jibSheetLine = rig.getObjectByName('jibSheet') as THREE.Line | undefined;

    // ---- Mainsail (grot) ----
    if (main) {
      const show = !capsized && mainDeploy > 0.05;
      main.visible = show;
      // The boom is a fixed spar: it stays on the mast even when the sail is
      // furled (it just rests near the centreline).
      const boomY = 0.92;
      const foot = 1.05;
      const boomAngle = show ? 0.12 + (1 - mainSheet) * 0.95 : 0.1;
      const tack = new THREE.Vector3(0.25, boomY, 0);
      const clew = new THREE.Vector3(
        0.25 - Math.cos(boomAngle) * foot,
        boomY,
        lee * Math.sin(boomAngle) * foot,
      );
      if (boom) {
        boom.visible = !capsized;
        this.alignSpar(boom, tack, clew);
      }
      if (show) {
        // Tall, higher-cut main running well up the taller mast.
        const headY = boomY + 1.55 * (0.62 + 0.38 * mainDeploy);
        const head = new THREE.Vector3(0.25, headY, 0);
        const power = mainDeploy * (0.35 + 0.65 * mainSheet);
        const belly = mainLuff ? 0.05 : 0.34 * power;
        const flutter = mainLuff ? 0.14 * gust : 0.02;
        this.updateSail(main, tack, head, clew, lee, belly, flutter, t);
        // Mainsheet: from the boom clew down to the traveller on the cockpit sole.
        if (mainSheetLine) {
          mainSheetLine.visible = true;
          this.setLine(mainSheetLine, clew, new THREE.Vector3(-0.5, 0.42, 0));
        }
      } else if (mainSheetLine) {
        mainSheetLine.visible = false;
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
        const tack = new THREE.Vector3(1.15, 0.2, 0);
        const head = new THREE.Vector3(0.28, 2.4, 0); // luff runs the full forestay
        const jibFoot = 1.0;
        const jibAngle = 0.2 + (1 - jibSheet) * 0.95;
        const fullClew = new THREE.Vector3(
          1.15 - Math.cos(jibAngle) * jibFoot,
          0.5,
          lee * Math.sin(jibAngle) * jibFoot,
        );
        // Roller furl: clew rolls in toward the tack/stay as the sail furls.
        const clew = tack.clone().lerp(fullClew, rolled);
        const power = rolled * (0.35 + 0.65 * jibSheet);
        const belly = jibLuff ? 0.05 : 0.3 * power;
        const flutter = jibLuff ? 0.16 * gust : 0.025;
        this.updateSail(jib, tack, head, clew, lee, belly, flutter, t + 1.7);
        // Jib sheet: from the clew back to a fairlead on the side deck.
        if (jibSheetLine) {
          jibSheetLine.visible = true;
          this.setLine(jibSheetLine, clew, new THREE.Vector3(-0.05, 0.46, lee * 0.34));
        }
      } else if (jibSheetLine) {
        jibSheetLine.visible = false;
      }
      if (furl) {
        // Thin foil when unfurled, only a slim roll of cloth when furled away.
        furl.visible = !capsized;
        const r = 0.012 + 0.03 * (1 - this.clamp01(jibDeploy));
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

  private update(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }
    const t = this.clock.getElapsedTime();

    this.ensureIslands();
    this.syncBoats(t);

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

    // Third-person chase camera: sit just astern of the player and above the
    // deck, turning WITH the boat's heading (like the skipper's own view), so
    // steering left swings the whole world left. The boat stays centred.
    // Third-person chase camera locked astern of the player and turning WITH the
    // boat's heading, so the boat stays dead-centre in the frame. We read the
    // boat mesh's own position so the target can never drift from what's drawn.
    const player = this.playerBoatId ? this.boats.find((b) => b.boatId === this.playerBoatId) : undefined;
    const boatMesh = this.playerBoatId ? this.boatMeshes.get(this.playerBoatId) : undefined;
    const h = ((player ? player.heading : 90) * Math.PI) / 180;
    const boatPos = boatMesh ? boatMesh.position : new THREE.Vector3(p.x, this.waveHeight(p.x, p.y, t), p.y);
    const camTarget = new THREE.Vector3(boatPos.x, boatPos.y + 1.3, boatPos.z);
    const camDist = 8.5;
    const camHeight = 4.4;

    // Advance the manual orbit (9 / 0 keys) using real elapsed time.
    const dt = this.lastTime ? Math.min(0.05, t - this.lastTime) : 0.016;
    this.lastTime = t;
    this.orbit += this.orbitDir * this.ORBIT_SPEED * dt;

    // View direction from the boat: astern by default (heading + PI), swung
    // around by the orbit angle so 9 / 0 rotate the camera about the ship.
    const viewAng = h + Math.PI + this.orbit;
    const off = new THREE.Vector3(Math.cos(viewAng), 0, Math.sin(viewAng));
    const desired = new THREE.Vector3(
      boatPos.x + off.x * camDist,
      boatPos.y + camHeight,
      boatPos.z + off.z * camDist,
    );
    // Smooth only the orbit position; lookAt always re-centres the boat.
    this.camera.position.lerp(desired, 0.3);
    this.camera.lookAt(camTarget);

    this.renderer.render(this.scene, this.camera);
  }
}
