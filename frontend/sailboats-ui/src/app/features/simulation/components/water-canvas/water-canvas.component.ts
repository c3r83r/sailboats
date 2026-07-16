import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { BoatState, Buoy, HelmControlState, Island, Projectile, SailControl } from '../../../../store/simulation/simulation.models';

type LakeRect = { x: number; y: number; width: number; height: number; radius: number };
type IslandMeta = { cx: number; cy: number; r: number; pts: { x: number; y: number }[] };
type WindParticle = { x: number; y: number; speed: number; length: number; alpha: number; local: number; life: number };
type Point = { x: number; y: number };
type SailVisualState = 'down' | 'luff' | 'trim' | 'stall' | 'back';
type BoatColor = { light: string; dark: string; edge: string; flag: string };

@Component({
  selector: 'app-water-canvas',
  standalone: true,
  imports: [CommonModule],
  template: '<div class="canvas-wrap" [class.fill]="fill"><canvas #canvas [class.dragging]="dragging" (wheel)="onWheel($event)" (pointerdown)="onPointerDown($event)" (pointermove)="onPointerMove($event)" (pointerup)="onPointerUp()" (pointerleave)="onPointerUp()" (dblclick)="resetView()"></canvas></div>',
  styles: [
    `
    .canvas-wrap {
      position: relative;
      width: 100%;
      max-width: calc(82vh * 1.78);
      aspect-ratio: 16 / 9;
      margin: 0 auto;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
    }
    .canvas-wrap.fill {
      max-width: none;
      aspect-ratio: auto;
      width: 100%;
      height: 100%;
      margin: 0;
      border-radius: 0;
      box-shadow: none;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
    }
    canvas.dragging {
      cursor: grabbing;
    }
    `,
  ],
})
export class WaterCanvasComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() boats: BoatState[] = [];
  @Input() projectiles: Projectile[] = [];
  @Input() buoys: Buoy[] = [];
  @Input() islands: Island[] = [];
  @Input() playerBoatId: string | null = null;
  @Input() controls: HelmControlState | null = null;
  @Input() mainState: SailVisualState = 'down';
  @Input() jibState: SailVisualState = 'down';
  @Input() heel = 0;
  @ViewChild('canvas') canvasRef?: ElementRef<HTMLCanvasElement>;

  private animationFrameId: number | null = null;
  private resizeObserver?: ResizeObserver;
  private phase = 0;
  private lastTime = 0;
  private windParticles: WindParticle[] = [];

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  // Stable leeward side near dead-downwind so the rig doesn't flip every frame.
  private leewardHysteresis = 1;
  private islandMeta: IslandMeta[] = [];
  private lastIslandsRef: Island[] | null = null;
  // Half-arc (rad) around dead downwind where the jib can be goose-winged
  // ("na motyla"); matches BUTTERFLY_BETA (162 deg) on the helm side.
  private readonly butterflyArc = (18 * Math.PI) / 180;

  @Input() worldWidth = 28;
  @Input() worldHeight = 15.75;
  // Fill the parent (used by the app's fullscreen mode) instead of a 16:9 box.
  @Input() fill = false;
  // Wind blows toward this screen angle (0=right/E, 90=down/S); per-lake value.
  @Input() windDirection = 90;
  // Current (gusted) wind strength; scales the wind-line speed/brightness.
  @Input() windStrength = 5;
  // Camera zoom controlled by the mouse wheel; 1 = default framing (small lake fits).
  private zoom = 1;
  private readonly MAX_ZOOM = 4;
  // World units shown across the canvas width at zoom 1 (= small lake width).
  private readonly VIEW_SPAN = 28;
  private readonly WIND_SCREEN_SPEED = 75;
  // Reference view at the last reseed, to detect big zoom/teleport changes.
  private seedPpu = 0;
  private prevViewCx = 0;
  private prevViewCy = 0;
  // Camera: follow the player by default; dragging switches to a stable free look.
  private followMode = true;
  private camX = 0;
  private camY = 0;
  dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  // Fixed scene light for the 2.5D look: sun sits high on the upper-left, so
  // every cast shadow falls toward the lower-right by this screen-space offset.
  private readonly shadowDir = { x: 0.62, y: 0.78 };

  ngAfterViewInit(): void {
    this.setupResponsiveCanvas();
    this.initWindParticles();
    this.startAnimation();
  }

  ngOnChanges(): void {
    // A new (bigger/smaller) lake changes how far you can zoom out.
    this.zoom = this.clamp(this.zoom, this.minZoom(), this.MAX_ZOOM);
    if (this.islands !== this.lastIslandsRef) {
      this.lastIslandsRef = this.islands;
      this.rebuildIslandMeta();
    }
    // The animation loop already redraws every frame; no extra draw needed here.
  }

  // Cache island centres/radii so the venturi (nozzle) effect is cheap to sample.
  private rebuildIslandMeta(): void {
    this.islandMeta = (this.islands ?? []).map((isl) => {
      const n = isl.points.length || 1;
      let cx = 0;
      let cy = 0;
      for (const p of isl.points) {
        cx += p.x;
        cy += p.y;
      }
      cx /= n;
      cy /= n;
      let r = 0;
      for (const p of isl.points) {
        r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
      }
      return { cx, cy, r, pts: isl.points };
    });
  }

  // Even-odd point-in-polygon test against the island silhouette.
  private pointInPolygon(x: number, y: number, pts: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Local wind multiplier mirroring the backend: blocked over islands, slowed in
  // their lee shadow, and funnelled (venturi) through a gap between two close
  // islands whose connecting line is within 45 deg of perpendicular to the wind.
  private windFieldFactor(x: number, y: number): number {
    const rad = (this.windDirection * Math.PI) / 180;
    const wx = Math.cos(rad);
    const wy = Math.sin(rad);
    let factor = 1;
    let aMeta: IslandMeta | null = null;
    let bMeta: IslandMeta | null = null;
    let bestE = Infinity;
    let secondE = Infinity;
    let toAx = 0;
    let toAy = 0;
    let toBx = 0;
    let toBy = 0;
    for (const m of this.islandMeta) {
      const dx = x - m.cx;
      const dy = y - m.cy;
      const c = Math.hypot(dx, dy);
      const edge = c - m.r;
      if (edge < 0 && this.pointInPolygon(x, y, m.pts)) {
        factor = Math.min(factor, 0.12);
      }
      if (edge >= 0 && edge < 9) {
        const along = dx * wx + dy * wy;
        const across = Math.abs(-dx * wy + dy * wx);
        const half = m.r * 1.1;
        if (along > 0 && across < half) {
          const a = 1 - Math.min(1, along / (9 + m.r));
          const cc = 1 - Math.min(1, across / half);
          factor *= 1 - 0.6 * a * cc;
        }
      }
      if (edge < 6) {
        const ux = c > 1e-6 ? dx / c : 0;
        const uy = c > 1e-6 ? dy / c : 0;
        if (edge < bestE) {
          secondE = bestE;
          bMeta = aMeta;
          toBx = toAx;
          toBy = toAy;
          bestE = edge;
          aMeta = m;
          toAx = ux;
          toAy = uy;
        } else if (edge < secondE) {
          secondE = edge;
          bMeta = m;
          toBx = ux;
          toBy = uy;
        }
      }
    }
    if (aMeta && bMeta && secondE < 6) {
      const between = -(toAx * toBx + toAy * toBy);
      if (between > 0) {
        const lx = bMeta.cx - aMeta.cx;
        const ly = bMeta.cy - aMeta.cy;
        const ll = Math.hypot(lx, ly);
        if (ll > 1e-6) {
          const align = Math.abs((lx / ll) * wx + (ly / ll) * wy);
          if (align <= 0.70710678) {
            const perp = 1 - align / 0.70710678;
            const closeness = this.clamp(1 - (bestE + secondE) / 12, 0, 1);
            factor *= 1 + 0.6 * perp * closeness * between;
          }
        }
      }
    }
    return this.clamp(factor, 0.05, 1.7);
  }

  // Lowest zoom that still fits the whole lake; zoom out until it fills the view.
  private minZoom(): number {
    return this.VIEW_SPAN / this.worldWidth;
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.zoom = this.clamp(this.zoom * factor, this.minZoom(), this.MAX_ZOOM);
    this.draw();
  }

  onPointerDown(event: PointerEvent): void {
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    if (this.followMode) {
      // Start the free look from wherever the camera currently sits.
      this.camX = this.playerWorldX();
      this.camY = this.playerWorldY();
      this.followMode = false;
    }
    (event.target as Element)?.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    const ppu = this.pixelsPerUnit(this.cssWidth, this.cssHeight);
    // Grab-and-pull: dragging right shifts the view right (camera moves left).
    this.camX -= (event.clientX - this.lastPointerX) / ppu;
    this.camY -= (event.clientY - this.lastPointerY) / ppu;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.draw();
  }

  onPointerUp(): void {
    this.dragging = false;
  }

  resetView(): void {
    // Double-click: snap back to following the player at the default zoom.
    this.followMode = true;
    this.zoom = this.clamp(1, this.minZoom(), this.MAX_ZOOM);
    this.draw();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.resizeObserver?.disconnect();
  }

  private setupResponsiveCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(canvas);
    this.resizeCanvas();
  }

  private resizeCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    // Cap the backing-store resolution so a huge fullscreen canvas doesn't starve
    // the main thread (which would make the helm feel laggy / "stick").
    const rawDpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxW = 2200;
    const maxH = 1300;
    this.dpr = Math.max(1, Math.min(rawDpr, maxW / rect.width, maxH / rect.height));
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    canvas.width = Math.round(rect.width * this.dpr);
    canvas.height = Math.round(rect.height * this.dpr);

    this.initWindParticles();
    this.draw();
  }

  private startAnimation(): void {
    const loop = (now: number) => {
      const dt = this.lastTime ? Math.min(0.05, (now - this.lastTime) / 1000) : 0.016;
      this.lastTime = now;
      this.phase += dt * 2.4;
      this.updateWindParticles(dt);
      this.draw();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || this.cssWidth === 0) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Work in CSS pixels; the backing store is scaled for crisp high-DPI rendering.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const width = this.cssWidth;
    const height = this.cssHeight;
    const lake = this.getLakeRect(width, height);
    const scale = (lake.width / this.worldWidth) / 30;

    ctx.clearRect(0, 0, width, height);
    this.drawShore(ctx, width, height, lake);

    ctx.save();
    this.clipLake(ctx, lake);
    this.drawWater(ctx, lake);
    this.drawIslands(ctx, lake, scale);
    this.drawBuoys(ctx, lake, scale);
    // Wind blows over the islands too, so draw the particles on top of them.
    this.drawWindParticles(ctx, lake);

    if (!this.boats.length) {
      this.drawPlaceholderBoat(ctx, lake, scale);
      ctx.restore();
      this.drawLakeBorder(ctx, lake);
      return;
    }

    const wakeNow = performance.now();
    this.updateWakeTrails(wakeNow);
    this.drawWakeTrails(ctx, lake, scale, wakeNow);

    for (const boat of this.boats) {
      const x = this.mapWorldX(boat.x, lake);
      const y = this.mapWorldY(boat.y, lake);
      const isPlayer = this.playerBoatId === boat.boatId;
      const anchored = !!boat.anchored;
      const sunk = !!boat.sunk;
      const health = boat.health ?? 100;
      const jib = isPlayer && this.controls ? this.controls.jib : this.deriveAutoSail(boat.sailTrim, boat.heading);
      const main = isPlayer && this.controls ? this.controls.main : this.deriveAutoSail(boat.sailTrim, boat.heading);
      const rudder = isPlayer && this.controls ? this.controls.rudder : boat.rudder;

      // Other boats fall back to a generic trimmed look since we don't have their helm state.
      const mainSt: SailVisualState = isPlayer ? this.mainState : boat.sailTrim > 0.05 ? 'trim' : 'luff';
      const jibSt: SailVisualState = isPlayer ? this.jibState : boat.sailTrim > 0.05 ? 'trim' : 'luff';
      const capsized = !!boat.capsized;
      // Heel is now server-authoritative for every boat (degrees). Fall back to
      // the local player estimate only if the server hasn't sent one yet.
      const heelDeg = boat.heel ?? (isPlayer ? this.heel * 35 : 0);
      const heel = this.clamp(heelDeg / 35, -1.2, 1.2);
      const color = this.boatColor(boat.boatId);

      // Sunk hulls drop their sails like an anchored boat (no canvas, no way on).
      this.drawBoatShadow(ctx, x, y, scale, boat.heading, sunk || capsized);
      this.drawBoat(ctx, { x, y }, scale, boat.heading, boat.speed, main, jib, rudder, isPlayer, mainSt, jibSt, heel, color, anchored || sunk || capsized);

      if (anchored && !sunk && !capsized) {
        this.drawAnchorBadge(ctx, x, y, scale, boat.heading);
      }
      this.drawHealthBar(ctx, x, y, scale, health, sunk);
      if (capsized && !sunk) {
        ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
        ctx.font = `${Math.max(9, 11 * scale)}px Segoe UI`;
        ctx.textAlign = 'center';
        ctx.fillText('WYWRÓCONA', x, y - 24 * scale);
        ctx.textAlign = 'left';
      }

      ctx.fillStyle = isPlayer ? '#ffe19a' : boat.bot ? 'rgba(255, 180, 180, 0.92)' : 'rgba(248, 251, 255, 0.92)';
      ctx.font = `${Math.max(10, 13 * scale)}px Segoe UI`;
      ctx.fillText(boat.name ?? boat.boatId, x + 14 * scale, y - 14 * scale);
    }

    this.drawProjectiles(ctx, lake, scale);

    ctx.restore();
    this.drawLakeBorder(ctx, lake);
  }

  private drawBoat(
    ctx: CanvasRenderingContext2D,
    pos: Point,
    scale: number,
    heading: number,
    speed: number,
    main: SailControl,
    jib: SailControl,
    rudder: number,
    isPlayer: boolean,
    mainState: SailVisualState,
    jibState: SailVisualState,
    heel: number,
    color: BoatColor,
    anchored: boolean = false
  ): void {
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.scale(scale, scale);

    if (isPlayer) {
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 209, 102, 0.12)';
      ctx.fill();
    }

    // Anchored boats sit with sails dropped/furled. Override visual state so the
    // hull just weather-vanes in the wind without any canvas above the deck.
    const renderMain: SailControl = anchored ? { deploy: 0, sheet: 0, side: 0 } : main;
    const renderJib: SailControl = anchored ? { deploy: 0, sheet: 0, side: 0 } : jib;
    const renderMainState: SailVisualState = anchored ? 'luff' : mainState;
    const renderJibState: SailVisualState = anchored ? 'down' : jibState;
    const renderSpeed = anchored ? 0 : speed;

    // Which side is leeward in the boat's local frame (+1 starboard / -1 port)
    // and which direction the wind is blowing TO in that same frame.
    const windAngleLocal = ((this.windDirection - heading) * Math.PI) / 180;
    const lateral = Math.sin(windAngleLocal);
    // Hysteresis so the rig doesn't flip sides while running dead downwind.
    if (lateral > 0.08) {
      this.leewardHysteresis = 1;
    } else if (lateral < -0.08) {
      this.leewardHysteresis = -1;
    }
    const leewardSign = this.leewardHysteresis;

    this.drawHull(ctx, isPlayer, color);
    this.drawCannons(ctx);
    this.drawRudder(ctx, anchored ? 0 : rudder);

    // Wing-on-wing ("na motyla"): the jib carries a side it has been thrown to
    // with M and held by the whisker pole. It is winged (filling) when that side
    // is to windward, opposite the leeward main. On a gybe only the main swaps
    // sides, so the fixed-side jib ends up to leeward and just luffs until it is
    // re-winged. Other boats report no side, so they never goose-wing.
    const runZone = Math.cos(windAngleLocal) > Math.cos(this.butterflyArc);
    const jibDeployed = renderJib.deploy >= 0.05;
    const jibSide = renderJib.side;
    const butterfly = !anchored && jibDeployed && runZone && jibSide !== 0 && jibSide === -leewardSign;

    let jibToDraw = renderJib;
    let jibStateToDraw = renderJibState;
    if (butterfly) {
      // Winged to windward on the whisker pole, eased well out and filled.
      jibToDraw = { ...renderJib, sheet: 0.22, side: jibSide };
      jibStateToDraw = 'trim';
    } else if (!anchored && jibDeployed && runZone) {
      // Blanketed by the main on a run: luff on the leeward side, don't furl.
      jibToDraw = { ...renderJib, side: leewardSign };
      jibStateToDraw = 'luff';
    }

    // Heeled boats lean their rig to leeward; we model that with a small y-shear.
    ctx.save();
    const shear = this.clamp(heel, -1, 1) * 0.18;
    ctx.transform(1, 0, shear, 1, 0, 0);
    this.drawJibSail(ctx, jibToDraw, renderSpeed, leewardSign, jibStateToDraw, windAngleLocal, butterfly);
    this.drawMainSail(ctx, renderMain, renderSpeed, leewardSign, renderMainState, windAngleLocal);
    this.drawMast(ctx);
    ctx.restore();

    // Colourful identity flag at the masthead (drawn unsheared, in boat frame).
    this.drawFlag(ctx, windAngleLocal, color.flag);

    ctx.restore();
  }

  private drawAnchorBadge(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, heading: number): void {
    // Anchor glyph dropped at the bow (boats weather-vane bow-into-wind at anchor).
    const rad = (heading * Math.PI) / 180;
    const bow = 20 * scale;
    const r = Math.max(8, 10 * scale);
    const cx = x + Math.cos(rad) * bow;
    const cy = y + Math.sin(rad) * bow;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12, 24, 40, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.95)';
    ctx.lineWidth = Math.max(1, 1.4 * scale);
    ctx.stroke();

    // Anchor: ring + shank + crown arc.
    ctx.strokeStyle = '#ffe19a';
    ctx.lineWidth = Math.max(1, 1.6 * scale);
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.45, r * 0.18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.27);
    ctx.lineTo(cx, cy + r * 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy + r * 0.1);
    ctx.lineTo(cx + r * 0.45, cy + r * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.2, r * 0.5, Math.PI * 0.15, Math.PI - Math.PI * 0.15);
    ctx.stroke();
    ctx.restore();
  }

  private drawCannons(ctx: CanvasRenderingContext2D): void {
    // Gun positions in the boat's local frame: bow, stern, two per broadside.
    const guns = [
      { x: 16, y: 0 },
      { x: -15, y: 0 },
      { x: 4, y: -5 },
      { x: -6, y: -5 },
      { x: 4, y: 5 },
      { x: -6, y: 5 },
    ];
    ctx.fillStyle = '#241606';
    for (const g of guns) {
      ctx.beginPath();
      ctx.arc(g.x, g.y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawHealthBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    health: number,
    sunk: boolean,
  ): void {
    // Painted in screen space (no rotation) above the hull.
    if (health >= 100 && !sunk) {
      return;
    }
    const w = 26 * scale;
    const h = 4 * scale;
    const bx = x - w / 2;
    const by = y - 30 * scale;
    const frac = Math.max(0, Math.min(1, health / 100));

    ctx.fillStyle = 'rgba(8, 20, 34, 0.72)';
    ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);

    let col = '#5fd98a';
    if (frac < 0.3) {
      col = '#ff5c5c';
    } else if (frac < 0.6) {
      col = '#ffd166';
    }
    ctx.fillStyle = col;
    ctx.fillRect(bx, by, w * frac, h);

    if (sunk) {
      ctx.fillStyle = 'rgba(255, 140, 140, 0.95)';
      ctx.font = `${Math.max(9, 11 * scale)}px Segoe UI`;
      ctx.textAlign = 'center';
      ctx.fillText('ZATOPIONY', x, by - 4 * scale);
      ctx.textAlign = 'left';
    }
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, lake: LakeRect, scale: number): void {
    for (const p of this.projectiles) {
      const x = this.mapWorldX(p.x, lake);
      const y = this.mapWorldY(p.y, lake);
      const r = Math.max(1.6, 2.4 * scale);

      // Faint glow/splash halo so the shot reads on bright water.
      ctx.beginPath();
      ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 236, 188, 0.2)';
      ctx.fill();

      // Iron cannonball.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#160d04';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 214, 140, 0.9)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  private drawIslands(ctx: CanvasRenderingContext2D, lake: LakeRect, scale: number): void {
    for (let idx = 0; idx < this.islands.length; idx++) {
      const island = this.islands[idx];
      if (!island.points || island.points.length < 3) {
        continue;
      }
      const pts = island.points.map((p) => ({
        x: this.mapWorldX(p.x, lake),
        y: this.mapWorldY(p.y, lake),
      }));

      // Centroid for a soft sand-to-grass radial fill.
      let cx = 0;
      let cy = 0;
      for (const p of pts) {
        cx += p.x;
        cy += p.y;
      }
      cx /= pts.length;
      cy /= pts.length;

      let islandR = 0;
      for (const p of pts) {
        islandR = Math.max(islandR, Math.hypot(p.x - cx, p.y - cy));
      }

      // Top-down mound (matching the 3D view): the land sits flat on the water,
      // a sandy beach fringe easing into a grassy centre — no lifted cliff.
      // A sandy beach rim slightly wider than the waterline silhouette so land
      // eases into the water instead of ending on a hard edge.
      const beachPts = pts.map((p) => ({ x: cx + (p.x - cx) * 1.1, y: cy + (p.y - cy) * 1.1 }));

      const waterPath = this.islandPath(pts);
      const beachPath = this.islandPath(beachPts);

      // Cast shadow: the silhouette dropped toward the scene light so the land
      // reads as sitting just proud of the water.
      const shOff = Math.max(3, islandR * 0.1);
      const shadowPts = pts.map((p) => ({ x: p.x + this.shadowDir.x * shOff, y: p.y + this.shadowDir.y * shOff }));
      const shadowPath = this.islandPath(shadowPts);
      ctx.save();
      ctx.fillStyle = 'rgba(3, 14, 24, 0.28)';
      ctx.fill(shadowPath);
      ctx.restore();

      // Soft shallow-water glow so the island reads as a hazard from a distance.
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(180, 224, 205, 0.4)';
      ctx.lineWidth = 9 * scale;
      ctx.stroke(beachPath);
      ctx.restore();

      // Sandy beach rim at the waterline.
      const beach = ctx.createRadialGradient(cx, cy, islandR * 0.5, cx, cy, islandR * 1.12);
      beach.addColorStop(0, '#e9d7a4');
      beach.addColorStop(0.7, '#dcc487');
      beach.addColorStop(1, 'rgba(210, 190, 130, 0.35)');
      ctx.fillStyle = beach;
      ctx.fill(beachPath);

      // Grassy mound: warm sandy shore easing up to a green centre.
      const grad = ctx.createRadialGradient(cx, cy, islandR * 0.08, cx, cy, islandR * 1.02);
      grad.addColorStop(0, '#b9c47a'); // sun-bleached centre
      grad.addColorStop(0.4, '#86a860'); // grass
      grad.addColorStop(0.78, '#638a4b');
      grad.addColorStop(1, '#4d7440'); // shaded shore
      ctx.fillStyle = grad;
      ctx.fill(waterPath);

      // Vegetation detail: deterministic grass tufts and little trees clipped to
      // the island so the surface no longer reads as a flat blob.
      ctx.save();
      ctx.clip(waterPath);
      const rand = this.mulberry32(idx * 9973 + 17);
      const tufts = Math.round(this.clamp(islandR / 9, 5, 22));
      for (let i = 0; i < tufts; i++) {
        const ang = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * islandR * 0.82;
        const px = cx + Math.cos(ang) * rr;
        const py = cy + Math.sin(ang) * rr * 0.95;
        const rad = (2 + rand() * 3) * scale;
        // shadow blob then a lighter highlight for a soft tuft of foliage.
        ctx.fillStyle = 'rgba(58, 84, 44, 0.5)';
        ctx.beginPath();
        ctx.ellipse(px + scale, py + scale, rad * 1.15, rad, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rand() > 0.5 ? 'rgba(150, 180, 108, 0.8)' : 'rgba(122, 158, 92, 0.85)';
        ctx.beginPath();
        ctx.ellipse(px, py, rad, rad * 0.9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // A few small conifer trees near the centre for scale and life.
      const trees = Math.round(this.clamp(islandR / 22, 1, 5));
      for (let i = 0; i < trees; i++) {
        const ang = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * islandR * 0.5;
        const px = cx + Math.cos(ang) * rr;
        const py = cy + Math.sin(ang) * rr * 0.9;
        const th = (7 + rand() * 4) * scale;
        ctx.fillStyle = 'rgba(20, 40, 22, 0.35)';
        ctx.beginPath();
        ctx.ellipse(px + th * 0.4, py + th * 0.15, th * 0.7, th * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#3f6a37';
        ctx.beginPath();
        ctx.moveTo(px, py - th);
        ctx.lineTo(px - th * 0.5, py + th * 0.2);
        ctx.lineTo(px + th * 0.5, py + th * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#4f8043';
        ctx.beginPath();
        ctx.moveTo(px, py - th * 1.15);
        ctx.lineTo(px - th * 0.36, py - th * 0.1);
        ctx.lineTo(px + th * 0.36, py - th * 0.1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(58, 82, 46, 0.7)';
      ctx.lineWidth = 1.4 * scale;
      ctx.stroke(waterPath);
    }
  }

  // Small deterministic PRNG so island vegetation stays put frame to frame.
  private mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth, closed island outline through the given screen-space vertices.
  private islandPath(pts: Point[]): Path2D {
    const path = new Path2D();
    const n = pts.length;
    const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let start = mid(pts[n - 1], pts[0]);
    path.moveTo(start.x, start.y);
    for (let i = 0; i < n; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % n];
      const end = mid(curr, next);
      path.quadraticCurveTo(curr.x, curr.y, end.x, end.y);
    }
    path.closePath();
    return path;
  }

  private drawBuoys(ctx: CanvasRenderingContext2D, lake: LakeRect, scale: number): void {
    for (const buoy of this.buoys) {
      const x = this.mapWorldX(buoy.x, lake);
      const y = this.mapWorldY(buoy.y, lake);
      const r = Math.max(4, 7 * scale);
      const pulse = 0.55 + 0.25 * (0.5 + 0.5 * Math.sin(this.phase * 2));

      // Glow halo to flag the health pickup.
      ctx.beginPath();
      ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(64, 224, 132, ${0.16 * pulse})`;
      ctx.fill();

      // Buoy body.
      const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
      body.addColorStop(0, '#7bf7a8');
      body.addColorStop(1, '#1f9d52');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8, 40, 22, 0.85)';
      ctx.lineWidth = Math.max(1, 1.2 * scale);
      ctx.stroke();

      // White health cross.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.4, 1.8 * scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y - r * 0.5);
      ctx.lineTo(x, y + r * 0.5);
      ctx.moveTo(x - r * 0.5, y);
      ctx.lineTo(x + r * 0.5, y);
      ctx.stroke();
    }
  }

  // Deterministic, stable look per boat: hull is always a light wooden tone
  // (with subtle per-boat variation), the vivid identity colour lives on the flag.
  private boatColor(boatId: string): BoatColor {
    let hash = 0;
    for (let i = 0; i < boatId.length; i++) {
      hash = (hash * 31 + boatId.charCodeAt(i)) >>> 0;
    }
    const flagHue = hash % 360;
    const woodHue = 28 + (hash % 16); // 28..43 -> warm wood
    const woodLight = 74 + (hash % 6); // 74..79 -> light timber
    return {
      light: `hsl(${woodHue}, 46%, ${woodLight}%)`,
      dark: `hsl(${woodHue}, 44%, ${woodLight - 24}%)`,
      edge: `hsl(${woodHue}, 42%, 30%)`,
      flag: `hsl(${flagHue}, 82%, 56%)`,
    };
  }

  private drawBowWave(ctx: CanvasRenderingContext2D, speed: number): void {
    if (speed < 0.35) {
      return;
    }
    const intensity = this.clamp((speed - 0.35) / 0.9, 0, 1);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.25 + intensity * 0.45})`;
    ctx.lineWidth = 1 + intensity * 0.8;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.quadraticCurveTo(26 + intensity * 6, -7 - intensity * 3, 30 + intensity * 8, -2);
    ctx.moveTo(20, 0);
    ctx.quadraticCurveTo(26 + intensity * 6, 7 + intensity * 3, 30 + intensity * 8, 2);
    ctx.stroke();
  }

  private readonly wakeTrails = new Map<string, { x: number; y: number; born: number }[]>();
  private readonly WAKE_SPACING = 0.18;
  private readonly WAKE_LIFETIME = 2600; // ms each foam point stays before it fully fades
  private readonly WAKE_MAX_POINTS = 80;

  // Emit a foam point as each boat moves, then age EVERY trail out over a fixed
  // lifetime so the wake always fades smoothly with time -- it never snaps off
  // when the boat stops, and it keeps fading while the boat is slowing down.
  private updateWakeTrails(now: number): void {
    const present = new Set<string>();
    for (const boat of this.boats) {
      present.add(boat.boatId);
      let trail = this.wakeTrails.get(boat.boatId);
      const moving = !boat.sunk && !boat.anchored && (boat.speed ?? 0) >= 0.15;
      if (moving) {
        if (!trail) {
          trail = [];
          this.wakeTrails.set(boat.boatId, trail);
        }
        const head = trail[trail.length - 1];
        if (head && Math.hypot(boat.x - head.x, boat.y - head.y) > 3) {
          // Teleport (lake change / respawn): drop the old path and start fresh.
          trail.length = 0;
        }
        const tail = trail[trail.length - 1];
        if (!tail || Math.hypot(boat.x - tail.x, boat.y - tail.y) >= this.WAKE_SPACING) {
          trail.push({ x: boat.x, y: boat.y, born: now });
          if (trail.length > this.WAKE_MAX_POINTS) {
            trail.shift();
          }
        }
      }
      // Age points out by time regardless of speed, so a stopped or slowing boat's
      // wake keeps fading evenly instead of freezing or snapping away.
      if (trail) {
        while (trail.length && now - trail[0].born > this.WAKE_LIFETIME) {
          trail.shift();
        }
        if (!trail.length) {
          this.wakeTrails.delete(boat.boatId);
        }
      }
    }
    // Drop trails for boats that left the lake.
    for (const id of Array.from(this.wakeTrails.keys())) {
      if (!present.has(id)) {
        this.wakeTrails.delete(id);
      }
    }
  }

  // Fading, widening foam trail astern of each boat (replaces the old cone).
  private drawWakeTrails(ctx: CanvasRenderingContext2D, lake: LakeRect, scale: number, now: number): void {
    if (!this.wakeTrails.size) {
      return;
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const trail of this.wakeTrails.values()) {
      const n = trail.length;
      if (n < 2) {
        continue;
      }
      for (let i = 1; i < n; i++) {
        const p = trail[i];
        const age = Math.min(1, (now - p.born) / this.WAKE_LIFETIME); // 0 = fresh, 1 = gone
        const fade = 1 - age; // linear in time => even fade as the foam dissipates
        const x0 = this.mapWorldX(trail[i - 1].x, lake);
        const y0 = this.mapWorldY(trail[i - 1].y, lake);
        const x1 = this.mapWorldX(p.x, lake);
        const y1 = this.mapWorldY(p.y, lake);
        // Fresh foam at the stern is bright + narrow; it spreads and fades with age.
        ctx.strokeStyle = `rgba(214, 236, 255, ${0.42 * fade})`;
        ctx.lineWidth = (2 + 13 * age) * scale;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawMast(ctx: CanvasRenderingContext2D): void {
    // Maszt: wyrazny pierscien na wysokosci masztu (zgadza sie z mast.x w drawMainSail).
    ctx.fillStyle = '#3a2a12';
    ctx.strokeStyle = '#1a1208';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(5, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawShore(ctx: CanvasRenderingContext2D, width: number, height: number, lake: LakeRect): void {
    // No land border anymore: the area around the lake is just deep, dark water.
    const backdrop = ctx.createLinearGradient(0, 0, 0, height);
    backdrop.addColorStop(0, '#0a1e2b');
    backdrop.addColorStop(1, '#06141d');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);

    // Deeper, richer water body: sunlit teal at the top edge fading into a dark
    // blue-green depth toward the bottom for a more three-dimensional feel.
    const lakeGradient = ctx.createLinearGradient(lake.x, lake.y, lake.x, lake.y + lake.height);
    lakeGradient.addColorStop(0, '#3aa0d0');
    lakeGradient.addColorStop(0.4, '#1f79a6');
    lakeGradient.addColorStop(0.75, '#155571');
    lakeGradient.addColorStop(1, '#0e3b52');
    ctx.fillStyle = lakeGradient;
    this.roundedRect(ctx, lake.x, lake.y, lake.width, lake.height, lake.radius);
    ctx.fill();
  }

  // Living water: animated crest highlights drifting downwind, a shimmering sun
  // glint and a soft depth vignette. Replaces the old static grid.
  private drawWater(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    const rad = (this.windDirection * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    // Crest lines run perpendicular to the wind and scroll along it.
    const px = -dy;
    const py = dx;

    const cx = this.cssWidth / 2;
    const cy = this.cssHeight / 2;
    const reach = Math.hypot(this.cssWidth, this.cssHeight) / 2 + 40;
    const spacing = 58;
    const scroll = (this.phase * 12) % spacing;
    const gust = this.clamp(this.windStrength / 5, 0.5, 1.5);

    ctx.save();
    ctx.lineCap = 'round';
    for (let along = -reach; along <= reach; along += spacing) {
      const off = along + scroll;
      const k = off / spacing;
      const amp = 2.4 + 1.8 * Math.sin(this.phase * 1.1 + k);
      // Break each crest into a few short dashes so the water shimmers with
      // scattered wavelets instead of long, rain-like streaks.
      const segs = 7;
      for (let g = 0; g < segs; g++) {
        // Skip roughly every other dash, staggered per row, for a broken texture.
        if ((g + Math.floor(k)) % 2 === 0) {
          continue;
        }
        const t0 = -1 + (g / segs) * 2;
        const t1 = -1 + ((g + 0.6) / segs) * 2;
        const w0 = Math.sin(this.phase * 1.4 + t0 * 5 + k) * amp;
        const w1 = Math.sin(this.phase * 1.4 + t1 * 5 + k) * amp;
        const x0 = cx + dx * (off + w0) + px * t0 * reach;
        const y0 = cy + dy * (off + w0) + py * t0 * reach;
        const x1 = cx + dx * (off + w1) + px * t1 * reach;
        const y1 = cy + dy * (off + w1) + py * t1 * reach;
        const a = 0.03 + 0.02 * Math.sin(this.phase * 0.7 + k + g);
        ctx.strokeStyle = `rgba(224, 246, 255, ${Math.max(0.015, a) * gust})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Shimmering sun glint in the upper-left, matching the scene light.
    const gx = lake.x + lake.width * 0.32;
    const gy = lake.y + lake.height * 0.24;
    const gr = Math.max(lake.width, lake.height) * 0.55;
    const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    const gi = 0.1 + 0.03 * Math.sin(this.phase * 0.9);
    glint.addColorStop(0, `rgba(255, 244, 210, ${gi})`);
    glint.addColorStop(0.6, 'rgba(255, 244, 210, 0.03)');
    glint.addColorStop(1, 'rgba(255, 244, 210, 0)');
    ctx.fillStyle = glint;
    ctx.fillRect(lake.x, lake.y, lake.width, lake.height);

    // Depth vignette: darken the edges of the view so the centre reads closer.
    const vr = reach * 1.1;
    const vignette = ctx.createRadialGradient(cx, cy, vr * 0.45, cx, cy, vr);
    vignette.addColorStop(0, 'rgba(3, 18, 30, 0)');
    vignette.addColorStop(1, 'rgba(3, 16, 26, 0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(lake.x, lake.y, lake.width, lake.height);
  }

  // Soft cast shadow under a hull, offset toward the scene light direction.
  private drawBoatShadow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    heading: number,
    sunk: boolean,
  ): void {
    const off = 7 * scale;
    const ox = x + this.shadowDir.x * off;
    const oy = y + this.shadowDir.y * off;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.scale(scale, scale);
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 24);
    const base = sunk ? 0.16 : 0.3;
    grad.addColorStop(0, `rgba(3, 12, 22, ${base})`);
    grad.addColorStop(1, 'rgba(3, 12, 22, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, 23, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawWindParticles(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    const rad = (this.windDirection * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const gust = this.clamp(this.windStrength / 5, 0.45, 2.2);
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.1;
    for (const p of this.windParticles) {
      const sx = this.mapWorldX(p.x, lake);
      const sy = this.mapWorldY(p.y, lake);
      // Streak length in screen pixels (consistent at any zoom); gusts + venturi
      // lengthen/brighten it, island lee shadows shorten/dim it.
      const len = (7 + 7 * gust) * (0.4 + 0.6 * p.local) * p.length;
      const bright = (0.18 + 0.24 * gust) * (p.local > 1.05 ? 1.5 : 1) * (p.local < 0.6 ? 0.4 : 1);
      const a = this.clamp(bright * p.alpha, 0, 0.85);
      ctx.strokeStyle = `rgba(226, 247, 255, ${a})`;
      ctx.beginPath();
      ctx.moveTo(sx - dx * len, sy - dy * len);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
  }

  private drawWindLabel(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    ctx.fillStyle = 'rgba(198, 236, 255, 0.65)';
    ctx.font = `${Math.max(10, lake.width / 78)}px Segoe UI`;
    ctx.fillText('Wiatr: staly, z gory na dol', lake.x + 12, lake.y + 20);
  }

  // Compact kills/deaths leaderboard ("Z" = zwyciestwa, "S" = smierci) drawn in
  // the top-right corner, sorted by kills, with the player and bots highlighted.
  private drawScoreboard(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    if (!this.boats.length) {
      return;
    }
    const rows = [...this.boats]
      .sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || (a.deaths ?? 0) - (b.deaths ?? 0))
      .slice(0, 8);

    const pad = 8;
    const lh = Math.max(14, lake.width / 60);
    const w = Math.max(168, lake.width * 0.21);
    const h = pad * 2 + lh * (rows.length + 1);
    const x = lake.x + lake.width - w - 12;
    const y = lake.y + 12;

    ctx.save();
    ctx.fillStyle = 'rgba(8, 20, 34, 0.55)';
    this.roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.font = `600 ${lh * 0.78}px Segoe UI`;
    ctx.fillStyle = 'rgba(198, 236, 255, 0.9)';
    ctx.fillText('Tablica wynikow', x + pad, y + pad + lh * 0.5);
    ctx.textAlign = 'right';
    ctx.fillText('Z / S', x + w - pad, y + pad + lh * 0.5);
    ctx.textAlign = 'left';

    let i = 1;
    for (const b of rows) {
      const cy = y + pad + lh * (i + 0.5);
      const isP = b.boatId === this.playerBoatId;
      ctx.font = `${isP ? '700' : '400'} ${lh * 0.78}px Segoe UI`;
      ctx.fillStyle = isP ? '#ffe19a' : b.bot ? 'rgba(255, 180, 180, 0.92)' : 'rgba(248, 251, 255, 0.9)';
      const base = (b.name ?? b.boatId).slice(0, b.bot ? 10 : 14);
      const label = b.bot ? `${base} (bot)` : base;
      ctx.fillText(label, x + pad, cy);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(232, 244, 255, 0.92)';
      ctx.fillText(`${b.kills ?? 0} / ${b.deaths ?? 0}`, x + w - pad, cy);
      ctx.textAlign = 'left';
      i++;
    }

    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  private drawPlaceholderBoat(ctx: CanvasRenderingContext2D, lake: LakeRect, scale: number): void {
    const pos: Point = { x: lake.x + lake.width * 0.5, y: lake.y + lake.height * 0.5 };
    const controls = this.controls ?? {
      rudder: 0,
      sailTrim: 0,
      jib: { deploy: 0, sheet: 0, side: 0 },
      main: { deploy: 0, sheet: 0, side: 0 },
    };

    this.drawBoat(ctx, pos, scale, 270, 0.05, controls.main, controls.jib, controls.rudder, true, 'luff', 'down', 0, this.boatColor('player'));

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = `${Math.max(11, 13 * scale)}px Segoe UI`;
    ctx.fillText('Dolaczanie do akwenu...', pos.x + 28 * scale, pos.y - 12 * scale);
  }

  private drawLakeBorder(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    // Subtle dark rim just to seat the water in its frame (no green shore).
    ctx.strokeStyle = 'rgba(6, 20, 30, 0.55)';
    ctx.lineWidth = 2;
    this.roundedRect(ctx, lake.x, lake.y, lake.width, lake.height, lake.radius);
    ctx.stroke();
  }

  private drawHull(ctx: CanvasRenderingContext2D, isPlayer: boolean, color: BoatColor): void {
    const deck = ctx.createLinearGradient(0, -8, 0, 8);
    deck.addColorStop(0, color.light);
    deck.addColorStop(0.5, color.light);
    deck.addColorStop(1, color.dark);
    ctx.save();
    ctx.fillStyle = deck;
    ctx.strokeStyle = color.edge;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.quadraticCurveTo(10, -8, -10, -7);
    ctx.quadraticCurveTo(-16, -6, -17, 0);
    ctx.quadraticCurveTo(-16, 6, -10, 7);
    ctx.quadraticCurveTo(10, 8, 20, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Wooden planking: subtle fore-aft lines clipped to the hull.
    ctx.clip();
    ctx.strokeStyle = 'rgba(74, 48, 20, 0.22)';
    ctx.lineWidth = 0.5;
    for (const off of [-4, -1.5, 1.5, 4]) {
      ctx.beginPath();
      ctx.moveTo(19, off * 0.2);
      ctx.quadraticCurveTo(-2, off, -16, off * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // Cockpit, a darker wooden well.
    ctx.fillStyle = 'rgba(58, 38, 16, 0.55)';
    ctx.strokeStyle = 'rgba(36, 23, 10, 0.6)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.ellipse(-7, 0, 4.5, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (isPlayer) {
      // A small white bow marker so the player can always pick out their boat.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(15, 0, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawFlag(ctx: CanvasRenderingContext2D, windAngleLocal: number, flag: string): void {
    // Colourful burgee at the masthead, streaming downwind for boat identity.
    const mx = 5;
    const my = 0;
    const len = 8;
    const wob = Math.sin(this.phase * 3) * 0.2;
    const ang = windAngleLocal + wob;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const px = Math.cos(ang + Math.PI / 2);
    const py = Math.sin(ang + Math.PI / 2);
    const w = 2.8;

    ctx.beginPath();
    ctx.moveTo(mx + px * w * 0.5, my + py * w * 0.5);
    ctx.quadraticCurveTo(
      mx + dx * len * 0.5 + px * (w * 0.5 + wob * 2.5),
      my + dy * len * 0.5 + py * (w * 0.5 + wob * 2.5),
      mx + dx * len,
      my + dy * len
    );
    ctx.lineTo(mx - px * w * 0.5, my - py * w * 0.5);
    ctx.closePath();
    ctx.fillStyle = flag;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 0.35;
    ctx.stroke();

    // Masthead cap.
    ctx.beginPath();
    ctx.arc(mx, my, 1.0, 0, Math.PI * 2);
    ctx.fillStyle = '#2a1c0c';
    ctx.fill();
  }

  private drawMainSail(
    ctx: CanvasRenderingContext2D,
    sail: SailControl,
    speed: number,
    leewardSign: number,
    state: SailVisualState,
    windAngleLocal: number
  ): void {
    const deploy = this.clamp(sail.deploy, 0, 1);
    if (deploy < 0.05 || state === 'down') {
      return;
    }
    // Maszt w przednim trzecim kadlubie (kadlub: bow=+20, stern=-17, srodek=+1.5).
    const mast: Point = { x: 5, y: 0 };
    // Bom musi zmiescic sie w kadlubie: od masztu do rufy mamy 22 jednostki,
    // wiec maksymalny foot = ~19 dla pelnego wzniesienia.
    const footLen = 5 + 14 * deploy;

    if (state === 'luff') {
      // Luffing: the sail has no wind pressure and streams downwind, aligning
      // with the wind line. We confine it to the aft arc so it never pokes
      // ahead of the mast.
      const trail = this.luffTrailAngle(windAngleLocal);
      const clew: Point = {
        x: mast.x + Math.cos(trail) * footLen,
        y: mast.y + Math.sin(trail) * footLen,
      };
      this.drawBoom(ctx, mast, clew);
      this.drawLuffingSail(ctx, mast, clew, deploy, 7, 'rgba(255, 255, 255, 0.97)', 'rgba(255, 255, 255, 0.97)');
      return;
    }

    // Eased sheet => boom swings wide to leeward; sheeted in => boom near centreline.
    const boomAngle = 0.12 + (1 - sail.sheet) * 0.95;
    const clew: Point = {
      x: mast.x - Math.cos(boomAngle) * footLen,
      y: leewardSign * Math.sin(boomAngle) * footLen,
    };
    this.drawBoom(ctx, mast, clew);

    const stalled = state === 'stall';
    const fillPower = stalled ? 0.35 : this.clamp(sail.sheet, 0, 1);
    const belly = footLen * 0.22 * (0.4 + 0.6 * deploy) * (0.45 + 0.55 * fillPower);
    const flutter = stalled ? 0 : Math.sin(this.phase * 3 + speed * 2) * footLen * 0.03 * (1 - fillPower);

    this.drawCamberedSail(
      ctx,
      mast,
      clew,
      belly + Math.abs(flutter),
      leewardSign,
      stalled ? 'rgba(255, 232, 196, 0.97)' : '#ffffff',
      stalled ? 'rgba(255, 232, 196, 0.97)' : '#ffffff',
      0.62 // draft biased aft (bliziej clew / boom-tip)
    );
  }

  private drawJibSail(
    ctx: CanvasRenderingContext2D,
    sail: SailControl,
    speed: number,
    leewardSign: number,
    state: SailVisualState,
    windAngleLocal: number,
    goosewing: boolean = false
  ): void {
    const deploy = this.clamp(sail.deploy, 0, 1);
    if (deploy < 0.02 || state === 'down') {
      return; // furled on the roller
    }

    // Hals (tack) tuz przy dziobie. Luff (cieciwa) tak dlugi by clew
    // sheeted-in wladowal sie tuz przy maszcie, a eased ladnie wyszedl
    // na trawers w okolicy reling.
    const tack: Point = { x: 15, y: 0 };
    const luffLen = 4 + 10 * deploy;

    // Forestay od dziobu do masztu (zawsze rysowany przy wystawionym foku).
    ctx.strokeStyle = 'rgba(40, 40, 40, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(tack.x, tack.y);
    ctx.lineTo(5, 0);
    ctx.stroke();

    if (state === 'luff') {
      // Luffing jib streams downwind from the tack, aligned with the wind line.
      const trail = this.luffTrailAngle(windAngleLocal);
      const clew: Point = {
        x: tack.x + Math.cos(trail) * luffLen,
        y: tack.y + Math.sin(trail) * luffLen,
      };
      this.drawLuffingSail(ctx, tack, clew, deploy, 6, 'rgba(255, 255, 255, 0.95)', 'rgba(255, 255, 255, 0.95)');
      return;
    }

    const backwinded = state === 'back';
    const stalled = state === 'stall';
    // Draw the jib on the side it is actually sheeted (sail.side). This makes a
    // goose-winged (butterfly) jib appear on the opposite side to the main.
    const sideSign = sail.side !== 0 ? sail.side : leewardSign;
    const clewSign = sideSign;
    const bellySign = backwinded ? -sideSign : sideSign;
    // Wybrany szot (sheet=1) => maly kat -> clew blisko osi lodki, sail plaski.
    // Wyluzowany (sheet=0) => szeroki kat -> clew wachluje na burte (do ~70 deg).
    const sheetAngle = 0.18 + (1 - sail.sheet) * 1.0;
    const clew: Point = {
      x: tack.x - Math.cos(sheetAngle) * luffLen,
      y: clewSign * Math.sin(sheetAngle) * luffLen,
    };

    const power = stalled ? 0.35 : this.clamp(sail.sheet, 0, 1);
    const belly = luffLen * 0.26 * (0.4 + 0.6 * deploy) * (0.4 + 0.6 * power);
    const flutter = stalled ? 0 : Math.cos(this.phase * 3.4 + speed * 2.4) * luffLen * 0.04 * (1 - power);

    const fill = backwinded
      ? 'rgba(255, 198, 198, 0.97)'
      : stalled
        ? 'rgba(255, 232, 196, 0.97)'
        : '#ffffff';
    const stroke = fill;

    if (goosewing) {
      // Whisker pole bracing the goose-winged jib out to windward (butterfly).
      ctx.strokeStyle = 'rgba(58, 42, 18, 0.95)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(clew.x, clew.y);
      ctx.stroke();
    }

    this.drawCamberedSail(ctx, tack, clew, belly + Math.abs(flutter), bellySign, fill, stroke, 0.6);
  }

  private drawBoom(ctx: CanvasRenderingContext2D, mast: Point, clew: Point): void {
    ctx.strokeStyle = 'rgba(58, 42, 18, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(mast.x, mast.y);
    ctx.lineTo(clew.x, clew.y);
    ctx.stroke();
  }

  // Renders a sail that has lost its trim: it shows as a wavy, fluttering ribbon
  // with no consistent belly side. Used for both luffing and dumped sheets.
  private drawLuffingSail(
    ctx: CanvasRenderingContext2D,
    a: Point,
    b: Point,
    deploy: number,
    waves: number,
    fill: string,
    stroke: string
  ): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) {
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const amplitude = len * 0.18 * deploy;
    const segments = 24;
    const speedPhase = this.phase * 7;

    const points: Point[] = [];
    const back: Point[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const baseX = a.x + dx * t;
      const baseY = a.y + dy * t;
      // Taper the flutter to zero at the attachment points (luff & clew).
      const taper = Math.sin(t * Math.PI);
      const w1 = Math.sin(t * Math.PI * waves + speedPhase) * amplitude * taper;
      const w2 = Math.cos(t * Math.PI * waves * 0.85 + speedPhase + 1.7) * amplitude * 0.55 * taper;
      points.push({ x: baseX + px * w1, y: baseY + py * w1 });
      back.push({ x: baseX - px * w2, y: baseY - py * w2 });
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    for (let i = back.length - 1; i >= 0; i--) {
      ctx.lineTo(back[i].x, back[i].y);
    }
    ctx.closePath();

    // Plain bright sail, no outline (small shapes read better clean).
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // Direction (local frame) a luffing sail should trail so it lines up with the
  // wind. windAngleLocal points the way the wind blows TO; the sail streams that
  // way, but is confined to the aft arc (dead-astern +/- SPREAD) so it can never
  // point ahead of its attachment and poke past the bow.
  private luffTrailAngle(windAngleLocal: number): number {
    const SPREAD = (60 * Math.PI) / 180;
    const aft = Math.PI; // dead astern in the local frame
    let d = windAngleLocal - aft;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    d = Math.max(-SPREAD, Math.min(SPREAD, d));
    const wobble = Math.sin(this.phase * 1.4) * 0.06;
    return aft + d + wobble;
  }

  // Draws a sail as a thin cambered crescent (an airfoil seen from above)
  // bulging toward the requested leeward side between two attachment points.
  // draftPosition (0..1) shifts the peak of the bulge along the chord;
  // 0.5 = dead center, 0.6 = biased aft toward leech/clew (looks more like a
  // pressurised sail with most of the depth near the boom).
  private drawCamberedSail(
    ctx: CanvasRenderingContext2D,
    a: Point,
    b: Point,
    belly: number,
    leewardSign: number,
    fill: string,
    stroke: string,
    draftPosition: number = 0.5
  ): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;

    // Perpendicular to the chord, flipped so the belly bulges to leeward.
    let px = -dy / len;
    let py = dx / len;
    if ((py >= 0 ? 1 : -1) !== leewardSign) {
      px = -px;
      py = -py;
    }

    const peak = this.clamp(draftPosition, 0.15, 0.85);
    const sigma = 0.22;
    const outerAmp = Math.abs(belly);
    const innerAmp = outerAmp * 0.5;
    const segments = 16;
    const outer: Point[] = [];
    const inner: Point[] = [];

    // Build a stable cambered ribbon sampled along the chord. This avoids
    // bezier self-intersections that can visually throw the belly ahead of the bow.
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const baseX = a.x + dx * t;
      const baseY = a.y + dy * t;
      const g = Math.exp(-Math.pow(t - peak, 2) / (2 * sigma * sigma));
      const gInner = Math.exp(-Math.pow(t - (peak - 0.03), 2) / (2 * (sigma * 1.15) * (sigma * 1.15)));

      outer.push({
        x: baseX + px * outerAmp * g,
        y: baseY + py * outerAmp * g,
      });
      inner.push({
        x: baseX + px * innerAmp * gInner,
        y: baseY + py * innerAmp * gInner,
      });
    }

    ctx.beginPath();
    ctx.moveTo(outer[0].x, outer[0].y);
    for (let i = 1; i < outer.length; i++) {
      ctx.lineTo(outer[i].x, outer[i].y);
    }
    for (let i = inner.length - 1; i >= 0; i--) {
      ctx.lineTo(inner[i].x, inner[i].y);
    }
    ctx.closePath();

    // Plain bright sail, no outline (small shapes read better clean).
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  private drawRudder(ctx: CanvasRenderingContext2D, rudder: number): void {
    // Klawisz A (rudder < 0) wychyla pioro na bakburte (port, -y w lokalnej
    // ramie lodki), dzieki czemu lodka skreca w lewo. Klawisz D - analogicznie
    // w prawo. Stad odwrocony znak: blade angle = -rudder.
    const angle = -rudder * 0.85;
    ctx.save();
    ctx.translate(-17, 0);
    ctx.rotate(angle);
    ctx.strokeStyle = '#241803';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-8, 0);
    ctx.stroke();
    ctx.restore();
  }

  private deriveAutoSail(trim: number, heading: number): SailControl {
    // Other boats only report their net drive (sailTrim), not helm state. Bots
    // autotrim, so we set their sheets to the optimum for their current point of
    // sail - eased right out on a run, hauled in close-hauled - mirroring the
    // player's optimalSheet curve so their sails always read as perfectly set.
    const windFrom = this.windDirection + 180;
    let beta = (((heading - windFrom) % 360) + 360) % 360;
    if (beta > 180) {
      beta = 360 - beta; // 0 = head to wind, 90 = beam reach, 180 = dead run
    }
    const optimalSheet = this.clamp(1 - (beta - 30) / 130, 0, 1);
    return {
      deploy: 1,
      sheet: trim > 0.05 ? optimalSheet : this.clamp(0.3 + trim * 0.7, 0, 1),
      side: 0,
    };
  }

  private getLakeRect(width: number, height: number): LakeRect {
    const ppu = this.pixelsPerUnit(width, height);
    const halfX = width / 2 / ppu;
    const halfY = height / 2 / ppu;
    const camX = this.cameraAxis(this.followMode ? this.playerWorldX() : this.camX, halfX, this.worldWidth);
    const camY = this.cameraAxis(this.followMode ? this.playerWorldY() : this.camY, halfY, this.worldHeight);
    return {
      x: width / 2 - camX * ppu,
      y: height / 2 - camY * ppu,
      width: this.worldWidth * ppu,
      height: this.worldHeight * ppu,
      radius: Math.min(width, height) * 0.03,
    };
  }

  private pixelsPerUnit(width: number, height: number): number {
    // Width-based so a 16:9 world fills the 16:9 canvas exactly at zoom 1.
    return (width / this.VIEW_SPAN) * this.zoom;
  }

  // Keep the camera inside the world on big lakes; centre dimensions that fit.
  private cameraAxis(target: number, half: number, worldDim: number): number {
    if (worldDim <= half * 2) {
      return worldDim / 2;
    }
    return this.clamp(target, half, worldDim - half);
  }

  private playerWorldX(): number {
    const player = this.playerBoatId ? this.boats.find((b) => b.boatId === this.playerBoatId) : undefined;
    return player ? player.x : this.worldWidth / 2;
  }

  private playerWorldY(): number {
    const player = this.playerBoatId ? this.boats.find((b) => b.boatId === this.playerBoatId) : undefined;
    return player ? player.y : this.worldHeight / 2;
  }

  private mapWorldX(value: number, lake: LakeRect): number {
    return lake.x + (value / this.worldWidth) * lake.width;
  }

  private mapWorldY(value: number, lake: LakeRect): number {
    return lake.y + (value / this.worldHeight) * lake.height;
  }

  private initWindParticles(): void {
    if (this.cssWidth === 0) {
      this.windParticles = [];
      return;
    }
    const rect = this.visibleWorldRect();
    this.windParticles = Array.from({ length: 220 }, () => this.spawnParticle(rect));
  }

  private updateWindParticles(dt: number): void {
    if (this.cssWidth === 0) {
      return;
    }
    if (!this.windParticles.length) {
      this.initWindParticles();
      return;
    }
    const rect = this.visibleWorldRect();
    const viewCx = (rect.minX + rect.maxX) / 2;
    const viewCy = (rect.minY + rect.maxY) / 2;
    const viewW = rect.maxX - rect.minX;
    // Redistribute the whole field when the view changes a lot (zoom or a sudden
    // jump/teleport) so particles never stay bunched where the old view was.
    const zoomRatio = this.seedPpu > 0 ? rect.ppu / this.seedPpu : 0;
    const teleported = Math.hypot(viewCx - this.prevViewCx, viewCy - this.prevViewCy) > viewW * 0.5;
    if (this.seedPpu === 0 || zoomRatio > 1.22 || zoomRatio < 0.82 || teleported) {
      for (const particle of this.windParticles) {
        Object.assign(particle, this.spawnParticle(rect));
      }
      this.seedPpu = rect.ppu;
    }
    this.prevViewCx = viewCx;
    this.prevViewCy = viewCy;

    const rad = (this.windDirection * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const gust = this.clamp(this.windStrength / 5, 0.45, 2.2);
    for (const p of this.windParticles) {
      p.local = this.windFieldFactor(p.x, p.y);
      // Speed is normalised to the screen so motion looks the same at any zoom.
      const worldV = (this.WIND_SCREEN_SPEED * p.speed * gust * p.local) / rect.ppu;
      p.x += dx * worldV * dt;
      p.y += dy * worldV * dt;
      p.life -= dt;
      // Recycle on timeout or when it leaves the view, re-seeding anywhere on
      // screen so the field is always full (never "fills in" from an edge).
      if (p.life <= 0 || p.x < rect.minX || p.x > rect.maxX || p.y < rect.minY || p.y > rect.maxY) {
        Object.assign(p, this.spawnParticle(rect));
      }
    }
  }

  // The world-space rectangle currently visible through the camera (+ ppu).
  private visibleWorldRect(): { minX: number; minY: number; maxX: number; maxY: number; ppu: number } {
    const lake = this.getLakeRect(this.cssWidth, this.cssHeight);
    const ppu = lake.width / this.worldWidth;
    const m = 1.5;
    return {
      minX: (0 - lake.x) / ppu - m,
      maxX: (this.cssWidth - lake.x) / ppu + m,
      minY: (0 - lake.y) / ppu - m,
      maxY: (this.cssHeight - lake.y) / ppu + m,
      ppu,
    };
  }

  private spawnParticle(rect: { minX: number; minY: number; maxX: number; maxY: number }): WindParticle {
    return {
      x: rect.minX + Math.random() * (rect.maxX - rect.minX),
      y: rect.minY + Math.random() * (rect.maxY - rect.minY),
      speed: 0.8 + Math.random() * 0.5,
      length: 0.7 + Math.random() * 0.6,
      alpha: 0.5 + Math.random() * 0.5,
      local: 1,
      life: 1.2 + Math.random() * 3.0,
    };
  }

  private clipLake(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    this.roundedRect(ctx, lake.x, lake.y, lake.width, lake.height, lake.radius);
    ctx.clip();
  }

  private roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
  ): void {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
