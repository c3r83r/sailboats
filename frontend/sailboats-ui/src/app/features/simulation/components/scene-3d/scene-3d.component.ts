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
    this.renderer.setSize(w, h, false);
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

  private makeBoat(): THREE.Group {
    const group = new THREE.Group();

    // Hull: an extruded boat outline (top-view silhouette) so it reads as a
    // proper hull from the oblique camera rather than a plain box.
    const hullMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#caa46a'), roughness: 0.7 });
    this.sharedMat.push(hullMat);
    const shape = new THREE.Shape();
    shape.moveTo(1.15, 0);
    shape.quadraticCurveTo(0.7, 0.42, -0.2, 0.44);
    shape.quadraticCurveTo(-0.75, 0.44, -0.95, 0.26);
    shape.lineTo(-0.95, -0.26);
    shape.quadraticCurveTo(-0.75, -0.44, -0.2, -0.44);
    shape.quadraticCurveTo(0.7, -0.42, 1.15, 0);
    const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 1 });
    hullGeo.rotateX(-Math.PI / 2); // lay the outline on the ground, extrude upward
    this.sharedGeo.push(hullGeo);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = 0.02;
    group.add(hull);

    // Cockpit well: a darker inset near the stern.
    const wellMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#5a3c1a'), roughness: 0.9 });
    const wellGeo = new THREE.BoxGeometry(0.5, 0.1, 0.34);
    this.sharedGeo.push(wellGeo);
    this.sharedMat.push(wellMat);
    const well = new THREE.Mesh(wellGeo, wellMat);
    well.position.set(-0.35, 0.36, 0);
    group.add(well);

    // Heel pivot: everything above the waterline tilts around the forward axis.
    const rig = new THREE.Group();
    rig.name = 'rig';
    group.add(rig);

    // Mast.
    const mastMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a2a12'), roughness: 0.8 });
    const mastGeo = new THREE.CylinderGeometry(0.05, 0.06, 2.3, 8);
    this.sharedGeo.push(mastGeo);
    this.sharedMat.push(mastMat);
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(0.25, 1.15, 0);
    rig.add(mast);

    // Mainsail: a plane aft of the mast.
    const sailMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#f4f8ff'),
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const sailGeo = new THREE.PlaneGeometry(1.2, 1.7);
    this.sharedGeo.push(sailGeo);
    this.sharedMat.push(sailMat);
    const sail = new THREE.Mesh(sailGeo, sailMat);
    sail.name = 'sail';
    sail.position.set(-0.35, 1.15, 0);
    sail.rotation.y = Math.PI / 2;
    rig.add(sail);

    this.scene?.add(group);
    return group;
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
      g.rotation.y = -(boat.heading * Math.PI) / 180;

      const rig = g.getObjectByName('rig') as THREE.Group | undefined;
      if (rig) {
        const capsized = !!boat.capsized;
        const heelDeg = boat.capsized ? 82 * Math.sign(boat.heel || 1) : boat.heel ?? 0;
        // Ease the visible heel toward the target for smoothness.
        const targetRad = (heelDeg * Math.PI) / 180;
        rig.rotation.x = rig.rotation.x + (targetRad - rig.rotation.x) * 0.2;
        const sail = rig.getObjectByName('sail') as THREE.Mesh | undefined;
        if (sail) {
          const trim = boat.sailTrim ?? 0;
          sail.visible = !capsized && trim > 0.05;
          // Boom swings out with an eased sheet.
          sail.rotation.x = (1 - trim) * 0.5;
        }
      }

      // Whole hull also tips slightly with the rig for a unified lean.
      const capRad = boat.capsized ? (82 * Math.PI) / 180 * Math.sign(boat.heel || 1) : ((boat.heel ?? 0) * Math.PI) / 180 * 0.25;
      g.rotation.z = g.rotation.z + (capRad - g.rotation.z) * 0.2;

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

    // Camera follows the player from behind-and-above for an oblique 3D view.
    const camTarget = new THREE.Vector3(p.x, 0.8, p.y);
    const desired = new THREE.Vector3(p.x, 10, p.y + 12);
    this.camera.position.lerp(desired, 0.08);
    this.camera.lookAt(camTarget);

    this.renderer.render(this.scene, this.camera);
  }
}
