import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { BoatState, Buoy, HelmControlState, Island, Projectile, SailControl } from '../../../../store/simulation/simulation.models';

type LakeRect = { x: number; y: number; width: number; height: number; radius: number };
type WindParticle = { x: number; y: number; speedNorm: number; drift: number; length: number; alpha: number };
type Point = { x: number; y: number };
type SailVisualState = 'down' | 'luff' | 'trim' | 'stall' | 'back';
type BoatColor = { light: string; dark: string; edge: string; flag: string };

@Component({
  selector: 'app-water-canvas',
  standalone: true,
  imports: [CommonModule],
  template: '<div class="canvas-wrap"><canvas #canvas></canvas></div>',
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
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
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
  // Half-arc (rad) around dead downwind where the jib is goose-winged ("na motyla").
  // Only a course very close to 0 deg (dead run) should wing the jib.
  private readonly butterflyArc = (12 * Math.PI) / 180;

  private readonly worldWidth = 20;
  private readonly worldHeight = 20;
  // Wind blows from the top of the screen to the bottom (matches the backend).
  private readonly windDir = 90;

  ngAfterViewInit(): void {
    this.setupResponsiveCanvas();
    this.initWindParticles();
    this.startAnimation();
  }

  ngOnChanges(): void {
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

    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
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
    const scale = lake.width / 880;

    ctx.clearRect(0, 0, width, height);
    this.drawShore(ctx, width, height, lake);

    ctx.save();
    this.clipLake(ctx, lake);
    this.drawWaterGrid(ctx, lake);
    this.drawIslands(ctx, lake, scale);
    this.drawBuoys(ctx, lake, scale);
    // Wind blows over the islands too, so draw the particles on top of them.
    this.drawWindParticles(ctx);

    if (!this.boats.length) {
      this.drawPlaceholderBoat(ctx, lake, scale);
      ctx.restore();
      this.drawLakeBorder(ctx, lake);
      this.drawWindLabel(ctx, lake);
      return;
    }

    for (const boat of this.boats) {
      const x = this.mapWorldX(boat.x, lake);
      const y = this.mapWorldY(boat.y, lake);
      const isPlayer = this.playerBoatId === boat.boatId;
      const anchored = !!boat.anchored;
      const sunk = !!boat.sunk;
      const health = boat.health ?? 100;
      const jib = isPlayer && this.controls ? this.controls.jib : this.deriveAutoSail(boat.sailTrim);
      const main = isPlayer && this.controls ? this.controls.main : this.deriveAutoSail(boat.sailTrim);
      const rudder = isPlayer && this.controls ? this.controls.rudder : boat.rudder;

      // Other boats fall back to a generic trimmed look since we don't have their helm state.
      const mainSt: SailVisualState = isPlayer ? this.mainState : boat.sailTrim > 0.05 ? 'trim' : 'luff';
      const jibSt: SailVisualState = isPlayer ? this.jibState : boat.sailTrim > 0.05 ? 'trim' : 'luff';
      const heel = isPlayer ? this.heel : 0;
      const color = this.boatColor(boat.boatId);

      // Sunk hulls drop their sails like an anchored boat (no canvas, no way on).
      this.drawBoat(ctx, { x, y }, scale, boat.heading, boat.speed, main, jib, rudder, isPlayer, mainSt, jibSt, heel, color, anchored || sunk);

      if (anchored && !sunk) {
        this.drawAnchorBadge(ctx, x, y, scale);
      }
      this.drawHealthBar(ctx, x, y, scale, health, sunk);

      ctx.fillStyle = isPlayer ? '#ffe19a' : 'rgba(248, 251, 255, 0.92)';
      ctx.font = `${Math.max(10, 13 * scale)}px Segoe UI`;
      ctx.fillText(boat.name ?? boat.boatId, x + 14 * scale, y - 14 * scale);
    }

    this.drawProjectiles(ctx, lake, scale);

    ctx.restore();
    this.drawLakeBorder(ctx, lake);
    this.drawWindLabel(ctx, lake);
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
    const windAngleLocal = ((this.windDir - heading) * Math.PI) / 180;
    const lateral = Math.sin(windAngleLocal);
    // Hysteresis so the rig doesn't flip sides while running dead downwind.
    if (lateral > 0.08) {
      this.leewardHysteresis = 1;
    } else if (lateral < -0.08) {
      this.leewardHysteresis = -1;
    }
    const leewardSign = this.leewardHysteresis;

    this.drawWake(ctx, renderSpeed);
    // this.drawBowWave(ctx, renderSpeed);
    this.drawHull(ctx, isPlayer, color);
    this.drawCannons(ctx);
    this.drawRudder(ctx, anchored ? 0 : rudder);

    // Wing-on-wing ("na motyla"): running close to dead downwind the mainsail
    // stays to leeward (it is the bigger sail and sets the side) while the jib is
    // goose-winged out to the opposite, windward side on a whisker pole.
    const running = Math.cos(windAngleLocal) > Math.cos(this.butterflyArc);
    const jibDeployed = renderJib.deploy >= 0.05;
    const butterfly = !anchored && running && jibDeployed;

    let jibToDraw = renderJib;
    let jibStateToDraw = renderJibState;
    let jibLeewardSign = leewardSign;
    if (butterfly) {
      jibLeewardSign = -leewardSign; // windward, opposite the mainsail
      jibStateToDraw = 'trim'; // the winged jib fills instead of luffing/furling
      // Ease it well out so the clew clearly wings to the side as a butterfly.
      jibToDraw = { ...renderJib, sheet: 0.22 };
    }

    // Heeled boats lean their rig to leeward; we model that with a small y-shear.
    ctx.save();
    const shear = this.clamp(heel, -1, 1) * 0.18;
    ctx.transform(1, 0, shear, 1, 0, 0);
    this.drawJibSail(ctx, jibToDraw, renderSpeed, jibLeewardSign, jibStateToDraw, windAngleLocal, butterfly);
    this.drawMainSail(ctx, renderMain, renderSpeed, leewardSign, renderMainState, windAngleLocal);
    this.drawMast(ctx);
    ctx.restore();

    // Colourful identity flag at the masthead (drawn unsheared, in boat frame).
    this.drawFlag(ctx, windAngleLocal, color.flag);

    ctx.restore();
  }

  private drawAnchorBadge(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    // Small anchor glyph above the boat, painted in screen space (no rotation).
    const r = Math.max(8, 10 * scale);
    const cx = x;
    const cy = y - 22 * scale;
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
    for (const island of this.islands) {
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

      const path = this.islandPath(pts);

      // Shallow-water halo around the island so it reads as a hazard.
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(173, 216, 196, 0.45)';
      ctx.lineWidth = 7 * scale;
      ctx.stroke();
      ctx.restore();

      let maxR = 0;
      for (const p of pts) {
        maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy));
      }
      const grad = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, maxR);
      grad.addColorStop(0, '#caa85f'); // sand core
      grad.addColorStop(0.45, '#7fa05a'); // grass
      grad.addColorStop(1, '#5d7e46'); // darker rim
      ctx.fillStyle = grad;
      ctx.fill(path);

      ctx.strokeStyle = 'rgba(60, 84, 48, 0.85)';
      ctx.lineWidth = 1.4 * scale;
      ctx.stroke(path);
    }
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

  private drawWake(ctx: CanvasRenderingContext2D, speed: number): void {
    const len = 14 + speed * 16;
    const gradient = ctx.createLinearGradient(-16, 0, -16 - len, 0);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-14, -4);
    ctx.lineTo(-16 - len, -1.5);
    ctx.lineTo(-16 - len, 1.5);
    ctx.lineTo(-14, 4);
    ctx.closePath();
    ctx.fill();
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
    backdrop.addColorStop(0, '#0b2230');
    backdrop.addColorStop(1, '#081a26');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);

    const lakeGradient = ctx.createLinearGradient(lake.x, lake.y, lake.x, lake.y + lake.height);
    lakeGradient.addColorStop(0, '#2d8ec4');
    lakeGradient.addColorStop(0.5, '#1f6d98');
    lakeGradient.addColorStop(1, '#174f72');
    ctx.fillStyle = lakeGradient;
    this.roundedRect(ctx, lake.x, lake.y, lake.width, lake.height, lake.radius);
    ctx.fill();
  }

  private drawWaterGrid(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    const stepX = lake.width / 16;
    const stepY = lake.height / 10;
    for (let x = lake.x + stepX; x < lake.x + lake.width; x += stepX) {
      ctx.beginPath();
      ctx.moveTo(x, lake.y);
      ctx.lineTo(x, lake.y + lake.height);
      ctx.stroke();
    }
    for (let y = lake.y + stepY; y < lake.y + lake.height; y += stepY) {
      ctx.beginPath();
      ctx.moveTo(lake.x, y);
      ctx.lineTo(lake.x + lake.width, y);
      ctx.stroke();
    }
  }

  private drawWindParticles(ctx: CanvasRenderingContext2D): void {
    ctx.lineCap = 'round';
    for (const particle of this.windParticles) {
      const wobble = Math.sin(this.phase + particle.y * 0.02) * particle.drift;
      const x = particle.x + wobble;
      ctx.strokeStyle = `rgba(226, 247, 255, ${particle.alpha})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, particle.y);
      ctx.lineTo(x - wobble * 0.3, particle.y - particle.length);
      ctx.stroke();
    }
  }

  private drawWindLabel(ctx: CanvasRenderingContext2D, lake: LakeRect): void {
    ctx.fillStyle = 'rgba(198, 236, 255, 0.65)';
    ctx.font = `${Math.max(10, lake.width / 78)}px Segoe UI`;
    ctx.fillText('Wiatr: staly, z gory na dol', lake.x + 12, lake.y + 20);
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

  private deriveAutoSail(trim: number): SailControl {
    // Other boats only report their net drive (sailTrim), not helm state. Keep
    // their sails fully hoisted so they read clearly, and let the sheet reflect
    // the drive rather than shrinking the canvas when they sail slowly.
    return {
      deploy: 1,
      sheet: this.clamp(0.3 + trim * 0.7, 0, 1),
      side: 0,
    };
  }

  private getLakeRect(width: number, height: number): LakeRect {
    const marginX = width * 0.012;
    const marginY = height * 0.02;
    return {
      x: marginX,
      y: marginY,
      width: width - marginX * 2,
      height: height - marginY * 2,
      radius: Math.min(width, height) * 0.03,
    };
  }

  private mapWorldX(value: number, lake: LakeRect): number {
    const clamped = this.clamp(value, 0, this.worldWidth);
    return lake.x + (clamped / this.worldWidth) * lake.width;
  }

  private mapWorldY(value: number, lake: LakeRect): number {
    const clamped = this.clamp(value, 0, this.worldHeight);
    return lake.y + (clamped / this.worldHeight) * lake.height;
  }

  private initWindParticles(): void {
    if (this.cssWidth === 0) {
      return;
    }
    const lake = this.getLakeRect(this.cssWidth, this.cssHeight);
    this.windParticles = Array.from({ length: 130 }, () =>
      this.createWindParticle(lake, lake.y + Math.random() * lake.height)
    );
  }

  private updateWindParticles(dt: number): void {
    if (this.cssWidth === 0) {
      return;
    }
    const lake = this.getLakeRect(this.cssWidth, this.cssHeight);
    if (!this.windParticles.length) {
      this.initWindParticles();
      return;
    }

    for (const particle of this.windParticles) {
      particle.y += particle.speedNorm * lake.height * dt;

      if (particle.y - particle.length > lake.y + lake.height) {
        const next = this.createWindParticle(lake, lake.y - Math.random() * lake.height * 0.2);
        Object.assign(particle, next);
      }
    }
  }

  private createWindParticle(lake: LakeRect, y: number): WindParticle {
    // speedNorm is the fraction of the lake height travelled per second,
    // giving a calm, constant drift (~7-12s top to bottom).
    return {
      x: lake.x + Math.random() * lake.width,
      y,
      speedNorm: 0.08 + Math.random() * 0.06,
      drift: 1 + Math.random() * 3,
      length: lake.height * (0.015 + Math.random() * 0.02),
      alpha: 0.25 + Math.random() * 0.4,
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
