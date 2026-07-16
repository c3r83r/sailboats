import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { FireSide, HelmControlState } from '../../../../store/simulation/simulation.models';

export type SailStateLabel = 'down' | 'luff' | 'trim' | 'stall' | 'back';
export type PointOfSailLabel = 'irons' | 'closehaul' | 'close' | 'beam' | 'broad' | 'deeprun' | 'run';

@Component({
  selector: 'app-control-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="deck" [class.overlay]="overlay">
      <header class="deck-head">
        <h2>Control Deck</h2>
        <span class="chips">
          <span class="auto-chip" *ngIf="autoTrim">&#9881; AUTO-TRYM</span>
          <span class="anchor-chip" *ngIf="controls.anchored">&#9875; KOTWICA</span>
        </span>
      </header>

      <div class="stats">
        <div class="stat">
          <span class="stat-label">Prędkość</span>
          <span class="stat-value">{{ boatSpeed | number : '1.1-1' }}<i>kn</i></span>
        </div>
        <div class="stat">
          <span class="stat-label">Wiatr</span>
          <span class="stat-value">{{ windStrength | number : '1.0-1' }}<i>kn</i></span>
          <span class="wind-arrow" [style.transform]="'rotate(' + (windDirection - 90) + 'deg)'">&#8595;</span>
        </div>
        <div class="stat">
          <span class="stat-label">Przechył</span>
          <span class="stat-value" [class.warn]="heelAbs >= 40">{{ heelAbs | number : '1.0-0' }}<i>&deg;{{ heelSide }}</i></span>
        </div>
      </div>

      <article class="card heel" [class.warn]="heelAbs >= 40">
        <div class="card-top">
          <span class="card-title">Wychylenie</span>
          <span class="card-meta">{{ heelLabel }}</span>
        </div>
        <div class="heel-track">
          <i class="heel-mid"></i>
          <i class="heel-mark" [style.left.%]="heelMarkLeft"></i>
        </div>
      </article>

      <article class="card hull" [class.warn]="health <= 30">
        <div class="card-top">
          <span class="card-title">Kadłub</span>
          <span class="card-meta">{{ health | number : '1.0-0' }}%</span>
        </div>
        <div class="bar big"><i class="fill hull" [class.low]="health <= 30" [style.width.%]="clampPct(health / 100)"></i></div>
      </article>

      <article class="card course" [class.warn]="pointOfSail === 'irons'">
        <div class="card-top">
          <span class="card-title">Kurs</span>
          <span class="card-sub">wzgl. wiatru</span>
        </div>
        <div class="course-value">{{ pointOfSailText }}</div>
      </article>

      <article class="card">
        <div class="card-top">
          <span class="card-title">Ster</span>
          <span class="card-meta">{{ rudderAngleAbs | number : '1.0-0' }}&deg; {{ rudderDir }}</span>
        </div>
        <div class="rudder-track">
          <i class="rudder-mid"></i>
          <i class="rudder-fill" [style.left.%]="rudderFillLeft" [style.width.%]="rudderFillWidth"></i>
        </div>
        <small [class.warn]="rudderBraking">{{ rudderBraking ? 'Za duży kąt — ster hamuje' : rudderHint }}</small>
      </article>

      <article class="card">
        <div class="card-top">
          <span class="card-title">Grot</span>
          <span class="badge" [ngClass]="'st-' + mainState">{{ stateText(mainState) }}</span>
        </div>
        <div class="meters">
          <div class="meter">
            <label>Rozwinięcie</label>
            <div class="bar"><i class="fill deploy" [style.width.%]="clampPct(controls.main.deploy)"></i></div>
            <em>{{ controls.main.deploy * 100 | number : '1.0-0' }}%</em>
          </div>
          <div class="meter">
            <label>Talia</label>
            <div class="bar"><i class="fill sheet" [style.width.%]="clampPct(controls.main.sheet)"></i></div>
            <em>{{ controls.main.sheet * 100 | number : '1.0-0' }}%</em>
          </div>
          <div class="meter">
            <label>Napęd</label>
            <div class="bar">
              <i class="fill main" [class.stall]="mainState === 'stall'" [style.width.%]="clampPct(mainThrust)"></i>
            </div>
            <em>{{ mainThrust * 100 | number : '1.0-0' }}%</em>
          </div>
        </div>
      </article>

      <article class="card">
        <div class="card-top">
          <span class="card-title">Fok</span>
          <span class="badge" [ngClass]="'st-' + jibState">{{ stateText(jibState) }}</span>
        </div>
        <div class="meters">
          <div class="meter">
            <label>Rozwinięcie</label>
            <div class="bar"><i class="fill deploy" [style.width.%]="clampPct(controls.jib.deploy)"></i></div>
            <em>{{ controls.jib.deploy * 100 | number : '1.0-0' }}%</em>
          </div>
          <div class="meter">
            <label>Szot {{ jibSideLabel }}</label>
            <div class="bar"><i class="fill sheet" [style.width.%]="clampPct(controls.jib.sheet)"></i></div>
            <em>{{ controls.jib.sheet * 100 | number : '1.0-0' }}%</em>
          </div>
          <div class="meter">
            <label>Napęd</label>
            <div class="bar">
              <i class="fill jib" [class.stall]="jibState === 'stall'" [class.back]="jibState === 'back'" [style.width.%]="clampPct(absJib)"></i>
            </div>
            <em>{{ jibThrust * 100 | number : '1.0-0' }}%</em>
          </div>
        </div>
      </article>

      <article class="card cannons">
        <div class="card-top">
          <span class="card-title">Działa</span>
          <span class="badge" [ngClass]="cannonReady ? 'st-trim' : 'st-stall'">{{ cannonStatusText }}</span>
        </div>
        <div class="meters">
          <div class="meter">
            <label>Ładowanie {{ armedSideLabel }}</label>
            <div class="bar"><i class="fill charge" [style.width.%]="clampPct(cannonCharge)"></i></div>
            <em>{{ cannonCharge * 100 | number : '1.0-0' }}%</em>
          </div>
          <div class="meter">
            <label>Przeładunek</label>
            <div class="bar"><i class="fill cool" [style.width.%]="clampPct(1 - cannonCooldown)"></i></div>
            <em>{{ cannonReady ? 'gotów' : 'czekaj' }}</em>
          </div>
        </div>
      </article>
    </section>
  `,
  styles: [
    `
    .deck {
      background: linear-gradient(160deg, rgba(13, 42, 71, 0.92), rgba(8, 28, 49, 0.92));
      border: 1px solid rgba(143, 227, 255, 0.22);
      border-radius: 18px;
      padding: 16px;
      display: grid;
      gap: 12px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
      backdrop-filter: blur(6px);
    }

    .deck.overlay {
      background: linear-gradient(160deg, rgba(13, 42, 71, 0.52), rgba(8, 28, 49, 0.52));
      backdrop-filter: blur(12px);
    }

    .deck-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    h2 {
      margin: 0;
      font-size: 1.18rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      color: var(--accent);
    }

    .anchor-chip {
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(255, 209, 102, 0.16);
      border: 1px solid rgba(255, 209, 102, 0.4);
      color: #ffe19a;
    }

    .chips {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .auto-chip {
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(143, 227, 255, 0.16);
      border: 1px solid rgba(143, 227, 255, 0.45);
      color: #cdf2ff;
    }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .stat {
      position: relative;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 10px 12px;
      display: grid;
      gap: 2px;
    }

    .stat-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.6;
    }

    .stat-value {
      font-size: 1.55rem;
      font-weight: 800;
      line-height: 1;
      color: #eaf6ff;
    }

    .stat-value i {
      font-size: 0.8rem;
      font-weight: 600;
      font-style: normal;
      opacity: 0.6;
      margin-left: 3px;
    }

    .wind-arrow {
      position: absolute;
      top: 10px;
      right: 12px;
      font-size: 1.4rem;
      line-height: 1;
      color: var(--sea-foam);
      transition: transform 0.2s ease;
    }

    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 11px 13px;
      display: grid;
      gap: 9px;
    }

    .card.warn {
      border-color: rgba(255, 154, 154, 0.45);
      background: rgba(122, 46, 46, 0.16);
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .card-title {
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-size: 0.82rem;
      color: #cfe9ff;
    }

    .card-sub { font-size: 0.72rem; opacity: 0.5; }
    .card-meta { font-size: 0.86rem; font-weight: 700; opacity: 0.85; }

    .course-value {
      font-size: 1.15rem;
      font-weight: 800;
      letter-spacing: 0.03em;
      color: var(--accent);
    }

    .card.warn .course-value { color: #ff9a9a; }

    .rudder-track {
      position: relative;
      height: 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
    }

    .rudder-mid {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 2px;
      transform: translateX(-1px);
      background: rgba(255, 255, 255, 0.35);
    }

    .rudder-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      border-radius: 999px;
      background: linear-gradient(90deg, #ffd166, #f4a52a);
      transition: left 0.08s linear, width 0.08s linear;
    }

    .heel-track {
      position: relative;
      height: 12px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(42,157,143,0.35), rgba(255,255,255,0.08) 45%, rgba(255,255,255,0.08) 55%, rgba(214,145,50,0.35));
      overflow: hidden;
    }

    .heel-mid {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 2px;
      transform: translateX(-1px);
      background: rgba(255, 255, 255, 0.4);
    }

    .heel-mark {
      position: absolute;
      top: -2px;
      width: 4px;
      height: 16px;
      border-radius: 2px;
      transform: translateX(-2px);
      background: #7bdff2;
      box-shadow: 0 0 6px rgba(123, 223, 242, 0.8);
      transition: left 0.1s linear;
    }

    .card.heel.warn .heel-mark { background: #ff9a9a; box-shadow: 0 0 6px rgba(255, 120, 120, 0.9); }

    .meters { display: grid; gap: 7px; }

    .meter {
      display: grid;
      grid-template-columns: 72px 1fr 38px;
      align-items: center;
      gap: 9px;
    }

    .meter label {
      font-size: 0.74rem;
      opacity: 0.7;
    }

    .meter em {
      font-style: normal;
      font-size: 0.78rem;
      font-weight: 700;
      text-align: right;
      opacity: 0.9;
    }

    .bar {
      position: relative;
      height: 9px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.09);
      overflow: hidden;
    }

    .bar.big { height: 13px; }

    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      display: block;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.18);
      transition: width 0.08s linear;
    }

    .fill.deploy { background: linear-gradient(90deg, #c8d8ff, #6f8fd6); }
    .fill.sheet { background: linear-gradient(90deg, #d8c8ff, #8a6fd6); }
    .fill.main { background: linear-gradient(90deg, #8fe3ff, #2d8ec4); }
    .fill.jib { background: linear-gradient(90deg, #b6f5c9, #2a9d8f); }
    .fill.stall { background: linear-gradient(90deg, #ffd9a3, #d68f2a); }
    .fill.back { background: linear-gradient(90deg, #ff9a9a, #c0392b); }
    .fill.hull { background: linear-gradient(90deg, #7ef0a6, #2a9d8f); }
    .fill.hull.low { background: linear-gradient(90deg, #ff9a9a, #c0392b); }
    .fill.charge { background: linear-gradient(90deg, #ffe19a, #ffb02e); }
    .fill.cool { background: linear-gradient(90deg, #8fc9ff, #2d6ec4); }

    small {
      font-size: 0.78rem;
      opacity: 0.85;
    }

    .badge {
      padding: 2px 9px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 0.68rem;
      letter-spacing: 0.05em;
      background: rgba(255, 255, 255, 0.12);
    }

    .badge.st-luff { background: rgba(255, 209, 102, 0.25); color: #ffe19a; }
    .badge.st-stall { background: rgba(214, 145, 50, 0.3); color: #ffd9a3; }
    .badge.st-back { background: rgba(192, 57, 43, 0.4); color: #ffb3b3; }
    .badge.st-trim { background: rgba(42, 157, 143, 0.35); color: #c8f5e6; }
    .badge.st-down { background: rgba(255, 255, 255, 0.1); color: #cdd9e6; }

    .warn { color: #ff9a9a; font-weight: 700; }
    `,
  ],
})
export class ControlPanelComponent {
  @Input() controls: HelmControlState = {
    rudder: 0,
    sailTrim: 0,
    jib: { deploy: 0, sheet: 0, side: 0 },
    main: { deploy: 0, sheet: 0, side: 0 },
    anchored: true,
  };
  @Input() mainThrust = 0;
  @Input() jibThrust = 0;
  @Input() rudderWork = 0;
  @Input() rudderBraking = false;
  @Input() mainState: SailStateLabel = 'down';
  @Input() jibState: SailStateLabel = 'down';
  @Input() pointOfSail: PointOfSailLabel = 'irons';
  @Input() boatSpeed = 0;
  @Input() autoTrim = false;
  @Input() overlay = false;
  @Input() health = 100;
  @Input() cannonCharge = 0;
  @Input() cannonCooldown = 0;
  @Input() armedSide: FireSide | null = null;
  @Input() windDirection = 0;
  @Input() windStrength = 0;
  @Input() heel = 0;

  get heelAbs(): number {
    return Math.abs(this.heel);
  }

  get heelSide(): string {
    if (this.heelAbs < 1) return '';
    return this.heel < 0 ? 'L' : 'P';
  }

  get heelLabel(): string {
    const a = this.heelAbs;
    if (a >= 50) return 'WYWROTKA!';
    if (a >= 40) return 'BURTA W WODZIE';
    if (a >= 22) return 'MOCNY PRZECHYŁ';
    if (a >= 8) return 'w przechyle';
    return 'na równej stępce';
  }

  // Marker on a -60..+60 deg track (0 = centre, upright).
  get heelMarkLeft(): number {
    const clamped = Math.max(-60, Math.min(60, this.heel));
    return 50 + (clamped / 60) * 50;
  }

  get rudderAngle(): number {
    return this.controls.rudder * 60;
  }

  get rudderAngleAbs(): number {
    return Math.abs(this.controls.rudder) * 60;
  }

  get rudderDir(): string {
    if (Math.abs(this.controls.rudder) < 0.02) return '';
    return this.controls.rudder < 0 ? 'L' : 'P';
  }

  get rudderFillLeft(): number {
    return this.controls.rudder >= 0 ? 50 : 50 + this.controls.rudder * 50;
  }

  get rudderFillWidth(): number {
    return Math.abs(this.controls.rudder) * 50;
  }

  get rudderHint(): string {
    if (Math.abs(this.controls.rudder) < 0.02) return 'Ster na wprost';
    return this.controls.rudder < 0 ? 'Skręt w lewo' : 'Skręt w prawo';
  }

  get absJib(): number {
    return Math.abs(this.jibThrust);
  }

  get jibSideLabel(): string {
    if (this.controls.jib.side < 0) return 'L';
    if (this.controls.jib.side > 0) return 'P';
    return '—';
  }

  get pointOfSailText(): string {
    switch (this.pointOfSail) {
      case 'irons': return 'W LINII WIATRU';
      case 'closehaul': return 'OSTRY BAJDEWIND';
      case 'close': return 'BAJDEWIND';
      case 'beam': return 'PÓŁWIATR';
      case 'broad': return 'BAKSZTAG';
      case 'deeprun': return 'PEŁNY BAKSZTAG';
      case 'run': return 'FORDEWIND';
    }
  }

  stateText(state: SailStateLabel): string {
    switch (state) {
      case 'luff': return 'ŁOPOCZE';
      case 'stall': return 'PRZEBRANA';
      case 'back': return 'KONTRA';
      case 'trim': return 'CIĄGNIE';
      case 'down': return 'ZWINIĘTY';
    }
  }

  clampPct(value: number): number {
    return Math.max(0, Math.min(1, value)) * 100;
  }

  get cannonReady(): boolean {
    return this.cannonCooldown <= 0.001;
  }

  get cannonStatusText(): string {
    if (this.armedSide) {
      return 'ŁADOWANIE';
    }
    return this.cannonReady ? 'GOTOWE' : 'PRZEŁADUNEK';
  }

  get armedSideLabel(): string {
    switch (this.armedSide) {
      case 'port': return '· lewa burta';
      case 'starboard': return '· prawa burta';
      case 'bow': return '· dziób';
      case 'stern': return '· rufa';
      default: return '';
    }
  }
}
