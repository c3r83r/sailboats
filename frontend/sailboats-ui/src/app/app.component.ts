import { AsyncPipe, CommonModule } from '@angular/common';
import { Component, DestroyRef, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { combineLatest } from 'rxjs';
import { ControlPanelComponent } from './features/simulation/components/control-panel/control-panel.component';
import { WaterCanvasComponent } from './features/simulation/components/water-canvas/water-canvas.component';
import { AuthService } from './core/services/auth.service';
import { SimulationActions } from './store/simulation/simulation.actions';
import { selectBoats, selectBuoys, selectConnected, selectControls, selectIslands, selectLake, selectPlayerBoatId, selectProjectiles, selectWind } from './store/simulation/simulation.selectors';
import { FireSide, HelmControlState } from './store/simulation/simulation.models';

export type SailVisualState = 'down' | 'luff' | 'trim' | 'stall' | 'back';
export type PointOfSail = 'irons' | 'closehaul' | 'close' | 'beam' | 'broad' | 'deeprun' | 'run';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, AsyncPipe, FormsModule, ControlPanelComponent, WaterCanvasComponent],
  template: `
    <main class="layout">
      <div class="welcome" *ngIf="!started">
        <form class="welcome-card" (ngSubmit)="submitAuth()">
          <h2>Ahoj, kapitanie!</h2>
          <p>{{ authMode === 'login' ? 'Zaloguj się, aby wypłynąć na akwen.' : 'Załóż konto, aby wypłynąć na akwen.' }}</p>
          <input
            class="welcome-input"
            type="email"
            name="email"
            [(ngModel)]="email"
            placeholder="Email"
            autocomplete="email"
            autofocus />
          <input
            class="welcome-input"
            type="password"
            name="password"
            [(ngModel)]="password"
            placeholder="Hasło (min. 8 znaków)"
            [attr.autocomplete]="authMode === 'login' ? 'current-password' : 'new-password'" />
          <input
            *ngIf="authMode === 'register'"
            class="welcome-input"
            type="text"
            name="displayName"
            [(ngModel)]="displayName"
            maxlength="40"
            placeholder="Nick (widoczny przy łódce)"
            autocomplete="off" />
          <p class="welcome-error" *ngIf="authError">{{ authError }}</p>
          <button type="submit" class="welcome-btn" [disabled]="authBusy">
            {{ authBusy ? 'Chwila...' : (authMode === 'login' ? 'Zaloguj i wypłyń' : 'Zarejestruj i wypłyń') }}
          </button>
          <button type="button" class="welcome-link" (click)="toggleAuthMode()">
            {{ authMode === 'login' ? 'Nie masz konta? Zarejestruj się' : 'Masz już konto? Zaloguj się' }}
          </button>
        </form>
      </div>

      <header>
        <div class="brand">
          <h1>Sailboats</h1>
          <p>Multiplayer real-time sailing simulator</p>
        </div>
        <div class="lake" *ngIf="lake$ | async as lake">
          <span class="lake-name">{{ lake.name ?? 'Akwen' }}</span>
          <span class="lake-count">{{ lake.boats }}/{{ lake.capacity }} łódek</span>
          <button type="button" class="lake-btn" (click)="changeLake()" [disabled]="(connected$ | async) !== true">
            Zmień akwen
          </button>
        </div>
        <span class="status" [class.online]="(connected$ | async) === true">
          {{ (connected$ | async) ? 'LIVE' : 'OFFLINE' }}
        </span>
        <button type="button" class="logout-btn" *ngIf="started" (click)="logout()">Wyloguj</button>
      </header>

      <div class="kbd-help">
        <span><b>A</b>/<b>D</b> ster</span>
        <span><b>G</b> staw grot &middot; <b>Shift+G</b> refuj &middot; <b>W</b>/<b>S</b> talia</span>
        <span><b>F</b> staw fok &middot; <b>Shift+F</b> refuj &middot; <b>E</b>/<b>Q</b> szot</span>
        <span><b>&larr;</b>/<b>&rarr;</b> działa burty &middot; <b>&uarr;</b>/<b>&darr;</b> dziób/rufa &middot; trzymaj = dalej</span>
        <span><b>T</b> auto-trym &middot; <b>K</b> kotwica &middot; <b>M</b> motyl (fordewind)</span>
      </div>

      <section class="content">
        <app-water-canvas
          [boats]="(boats$ | async) ?? []"
          [projectiles]="(projectiles$ | async) ?? []"
          [buoys]="(buoys$ | async) ?? []"
          [islands]="(islands$ | async) ?? []"
          [controls]="controls"
          [playerBoatId]="playerBoatId"
          [mainState]="mainState"
          [jibState]="jibState"
          [heel]="heel">
        </app-water-canvas>

        <app-control-panel
          [controls]="controls"
          [mainThrust]="mainThrust"
          [jibThrust]="jibThrust"
          [rudderWork]="rudderWork"
          [rudderBraking]="rudderBraking"
          [mainState]="mainState"
          [jibState]="jibState"
          [pointOfSail]="pointOfSail"
          [boatSpeed]="speedKnots"
          [autoTrim]="autoTrim"
          [health]="playerHealth"
          [cannonCharge]="cannonCharge"
          [cannonCooldown]="cannonCooldown"
          [armedSide]="chargingSide"
          [windDirection]="(wind$ | async)?.direction ?? 0"
          [windStrength]="(wind$ | async)?.strength ?? 0">
        </app-control-panel>
      </section>
    </main>
  `,
  styles: [
    `
    .layout {
      min-height: 100vh;
      width: 100%;
      max-width: 1840px;
      margin: 0 auto;
      padding: 14px 16px;
      display: grid;
      gap: 12px;
    }

    header {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .brand { display: grid; gap: 2px; }

    h1 {
      margin: 0;
      letter-spacing: 0.06em;
      font-weight: 800;
      font-size: clamp(1.8rem, 4vw, 2.6rem);
      background: linear-gradient(90deg, #8fe3ff, #ffd166);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    p {
      margin: 0;
      opacity: 0.75;
    }

    .status {
      margin-left: auto;
      background: rgba(122, 46, 46, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      padding: 7px 16px;
      font-weight: 800;
      letter-spacing: 0.08em;
      font-size: 0.78rem;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
    }
    .status.online {
      background: rgba(31, 143, 87, 0.9);
    }

    .lake {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      padding: 5px 6px 5px 16px;
    }

    .lake + .status {
      margin-left: 0;
    }

    .lake-name {
      font-weight: 800;
      letter-spacing: 0.04em;
      color: #d8f4ff;
    }

    .lake-count {
      font-size: 0.78rem;
      opacity: 0.75;
    }

    .lake-btn {
      border: 1px solid rgba(143, 227, 255, 0.4);
      background: rgba(143, 227, 255, 0.16);
      color: #d8f4ff;
      border-radius: 999px;
      padding: 6px 14px;
      font-weight: 700;
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .lake-btn:hover:not(:disabled) {
      background: rgba(143, 227, 255, 0.3);
    }

    .lake-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .welcome {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(6, 16, 28, 0.82);
      backdrop-filter: blur(6px);
    }

    .welcome-card {
      display: grid;
      gap: 12px;
      width: min(92vw, 380px);
      padding: 28px 26px;
      border-radius: 18px;
      background: rgba(16, 30, 48, 0.96);
      border: 1px solid rgba(143, 227, 255, 0.25);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      text-align: center;
    }

    .welcome-card h2 {
      margin: 0;
      font-size: 1.5rem;
      letter-spacing: 0.04em;
      color: #8fe3ff;
    }

    .welcome-card p {
      margin: 0;
      opacity: 0.8;
      font-size: 0.9rem;
    }

    .welcome-input {
      margin-top: 4px;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(143, 227, 255, 0.35);
      background: rgba(8, 18, 30, 0.9);
      color: #eaf6ff;
      font-size: 1rem;
      text-align: center;
      outline: none;
    }

    .welcome-input:focus {
      border-color: rgba(143, 227, 255, 0.7);
    }

    .welcome-btn {
      padding: 11px 16px;
      border-radius: 10px;
      border: 1px solid rgba(143, 227, 255, 0.45);
      background: linear-gradient(90deg, rgba(143, 227, 255, 0.28), rgba(255, 209, 102, 0.28));
      color: #eaf6ff;
      font-weight: 800;
      letter-spacing: 0.04em;
      font-size: 0.95rem;
      cursor: pointer;
      transition: filter 0.15s ease;
    }

    .welcome-btn:hover:not(:disabled) {
      filter: brightness(1.15);
    }

    .welcome-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .welcome-error {
      margin: 2px 0 0;
      color: #ff9a9a;
      font-size: 0.85rem;
    }

    .welcome-link {
      background: none;
      border: none;
      color: rgba(143, 227, 255, 0.85);
      font-size: 0.85rem;
      cursor: pointer;
      text-decoration: underline;
    }

    .welcome-link:hover {
      color: #eaf6ff;
    }

    .logout-btn {
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid rgba(143, 227, 255, 0.35);
      background: rgba(8, 18, 30, 0.6);
      color: #eaf6ff;
      font-size: 0.8rem;
      cursor: pointer;
    }

    .logout-btn:hover {
      filter: brightness(1.15);
    }

    .content {
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(0, 1fr) 340px;
      align-items: start;
    }

    .kbd-help {
      margin: 0;
      padding: 11px 14px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 0.86rem;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      align-items: center;
    }

    .kbd-help span { opacity: 0.85; }

    .kbd-help b {
      display: inline-block;
      min-width: 1.1em;
      text-align: center;
      padding: 1px 6px;
      margin: 0 1px;
      border-radius: 6px;
      background: rgba(143, 227, 255, 0.16);
      border: 1px solid rgba(143, 227, 255, 0.28);
      color: #d8f4ff;
      font-weight: 700;
      font-size: 0.82rem;
    }

    @media (max-width: 900px) {
      .content {
        grid-template-columns: 1fr;
      }

      .status {
        margin-left: 0;
      }
    }
    `,
  ],
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);

  controls: HelmControlState = {
    rudder: 0,
    sailTrim: 0,
    jib: { deploy: 0, sheet: 0, side: 0 },
    main: { deploy: 0, sheet: 0, side: 0 },
    anchored: true,
  };
  playerBoatId: string | null = null;

  // Welcome screen: the player logs in or registers before the world connects.
  started = false;
  authMode: 'login' | 'register' = 'login';
  email = '';
  password = '';
  displayName = '';
  authError = '';
  authBusy = false;

  // Live readouts for the control deck.
  mainThrust = 0;
  jibThrust = 0;
  rudderWork = 0;
  rudderBraking = false;
  mainState: SailVisualState = 'down';
  jibState: SailVisualState = 'down';
  pointOfSail: PointOfSail = 'irons';
  heel = 0; // -1..+1, positive = lean to starboard (player frame)
  autoTrim = false; // T key: auto-trim assist keeps both sheets at the optimum
  playerHealth = 100;

  // Gunnery: charge a side while its arrow is held, fire on release, then cool down.
  chargingSide: FireSide | null = null;
  chargeLevel = 0;
  private chargeStart = 0;
  private fireReadyAt = 0;
  private readonly CHARGE_TIME_MS = 1300;
  private readonly FIRE_COOLDOWN_MS = 2000;

  connected$ = this.store.select(selectConnected);
  boats$ = this.store.select(selectBoats);
  projectiles$ = this.store.select(selectProjectiles);
  buoys$ = this.store.select(selectBuoys);
  islands$ = this.store.select(selectIslands);
  wind$ = this.store.select(selectWind);
  controls$ = this.store.select(selectControls);
  playerBoatId$ = this.store.select(selectPlayerBoatId);
  lake$ = this.store.select(selectLake);

  // Wind blows straight down the screen (matches the backend constant).
  private readonly windDir = 90;
  // beta (angle off dead-downwind) at/above which the jib can be winged ("motyl").
  private readonly BUTTERFLY_BETA = 162;
  // Persistent side the jib is poled out to on a run: -1/+1 = winged on that
  // side, 0 = not winged (self-tacking). Only M flips it; a gybe leaves it put
  // so the main comes across and blankets the jib until it is re-winged.
  private jibWing = 0;
  private playerHeading = 90;
  private playerSpeed = 0;

  // Backend speed is in world units / second; scale it to a believable knot range.
  private readonly KNOTS_PER_UNIT = 4;

  get speedKnots(): number {
    return this.playerSpeed * this.KNOTS_PER_UNIT;
  }

  get cannonCharge(): number {
    return this.chargingSide ? this.chargeLevel : 0;
  }

  get cannonCooldown(): number {
    const remaining = (this.fireReadyAt - performance.now()) / this.FIRE_COOLDOWN_MS;
    return this.clamp(remaining, 0, 1);
  }

  private readonly pressed = new Set<string>();
  private loopHandle: ReturnType<typeof setInterval> | null = null;
  private lastSent = { rudder: 0, sailTrim: 0, anchored: true };
  private readonly CONTROLS_KEY = 'sailboats.controls';

  // Control rates (per second).
  private readonly RUDDER_RATE = 2.2;
  private readonly RUDDER_RETURN = 3.2;
  private readonly SHEET_RATE = 0.9;
  private readonly DEPLOY_RATE = 0.8;
  private readonly MAX_RUDDER_DEG = 60;

  ngOnInit(): void {
    // Try to resume an existing session from the HttpOnly refresh cookie so a
    // page reload / new tab drops the player straight back onto their boat.
    this.auth.refresh().subscribe({
      next: () => this.enterGame(),
      error: () => {
        /* No valid session: stay on the login screen. */
      },
    });

    this.controls$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((controls) => {
      this.controls = controls;
    });

    combineLatest([this.boats$, this.playerBoatId$])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([boats, playerBoatId]) => {
        this.playerBoatId = playerBoatId;
        if (!boats.length || !playerBoatId) {
          return;
        }

        const player = boats.find((b) => b.boatId === playerBoatId);
        if (!player) {
          return;
        }
        this.playerHeading = player.heading;
        this.playerSpeed = player.speed;
        this.playerHealth = player.health ?? 100;
      });

    // Continuous helm loop: ramps the rudder, auto-centers it, trims sails and
    // recomputes the effective drive even while the boat is turning.
    this.loopHandle = setInterval(() => this.tickControls(0.04), 40);
  }

  ngOnDestroy(): void {
    if (this.loopHandle !== null) {
      clearInterval(this.loopHandle);
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Let text fields (the nick input) keep their own keystrokes.
    if (this.isTextInput(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    // Arrows/space must never scroll the page during play (or between rounds).
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
      event.preventDefault();
    }

    // Welcome screen is up: page scroll is already blocked, ignore gameplay keys.
    if (!this.started) {
      return;
    }

    // Arrow keys aim the guns: charge the chosen side while held, fire on release.
    const side = this.arrowToSide(key);
    if (side) {
      if (this.chargingSide === null && performance.now() >= this.fireReadyAt) {
        this.chargingSide = side;
        this.chargeStart = performance.now();
        this.chargeLevel = 0;
      }
      return;
    }

    // X dumps the mainsheet completely and instantly.
    if (key === 'x') {
      this.controls = { ...this.controls, main: { ...this.controls.main, sheet: 0 } };
      this.recomputeAndDispatch();
      return;
    }

    // K toggles the anchor.
    if (key === 'k') {
      event.preventDefault();
      this.controls = { ...this.controls, anchored: !this.controls.anchored };
      this.recomputeAndDispatch();
      return;
    }

    // T toggles the auto-trim assist.
    if (key === 't') {
      this.autoTrim = !this.autoTrim;
      return;
    }

    // M throws the jib across to the other side ("na motyla"). On a run the jib
    // is held on its side by the whisker pole, so M just flips that side: the
    // first press from the blanketed (leeward) side wings it out to windward
    // where it fills; pressing again brings it back across.
    if (key === 'm') {
      if (this.controls.jib.deploy >= 0.05 && this.inButterflyZone()) {
        const lateral = Math.sin(this.deg2rad(this.windDir - this.playerHeading));
        const leewardSide = lateral >= 0 ? 1 : -1;
        const current = this.jibWing !== 0 ? this.jibWing : leewardSide;
        this.jibWing = -current;
        this.controls = { ...this.controls, jib: { ...this.controls.jib, side: this.jibWing } };
        this.recomputeAndDispatch();
      }
      return;
    }

    this.pressed.add(key);
  }

  @HostListener('window:keyup', ['$event'])
  onKeyUp(event: KeyboardEvent): void {
    if (!this.started || this.isTextInput(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    const side = this.arrowToSide(key);
    if (side && this.chargingSide === side) {
      this.fireSalvo();
      return;
    }
    this.pressed.delete(key);
  }

  // True when focus is in a text field, so we don't steal its keystrokes.
  private isTextInput(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) {
      return false;
    }
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  @HostListener('window:blur')
  onBlur(): void {
    this.pressed.clear();
    this.chargingSide = null;
    this.chargeLevel = 0;
  }

  private arrowToSide(key: string): FireSide | null {
    switch (key) {
      case 'arrowleft': return 'port';
      case 'arrowright': return 'starboard';
      case 'arrowup': return 'bow';
      case 'arrowdown': return 'stern';
      default: return null;
    }
  }

  private fireSalvo(): void {
    const side = this.chargingSide;
    if (!side) {
      return;
    }
    const power = this.chargeLevel;
    this.chargingSide = null;
    this.chargeLevel = 0;
    this.fireReadyAt = performance.now() + this.FIRE_COOLDOWN_MS;
    this.store.dispatch(SimulationActions.fire({ side, power }));
  }

  changeLake(): void {
    this.store.dispatch(SimulationActions.changeLake());
    // Drop focus off the button so arrow/space keys can't re-trigger it.
    (document.activeElement as HTMLElement | null)?.blur();
  }

  start(): void {
    // Retained for compatibility; the welcome form now calls submitAuth().
    this.submitAuth();
  }

  submitAuth(): void {
    const email = this.email.trim();
    const password = this.password;
    if (!email || !password) {
      this.authError = 'Podaj email i hasło.';
      return;
    }
    if (this.authMode === 'register' && password.length < 8) {
      this.authError = 'Hasło musi mieć min. 8 znaków.';
      return;
    }
    this.authBusy = true;
    this.authError = '';
    const request =
      this.authMode === 'login'
        ? this.auth.login(email, password)
        : this.auth.register(email, password, this.displayName.trim() || email.split('@')[0]);
    request.subscribe({
      next: () => {
        this.authBusy = false;
        this.enterGame();
      },
      error: (err) => {
        this.authBusy = false;
        this.authError = this.authErrorMessage(err?.status);
      },
    });
  }

  toggleAuthMode(): void {
    this.authMode = this.authMode === 'login' ? 'register' : 'login';
    this.authError = '';
  }

  logout(): void {
    this.auth.logout().subscribe({
      next: () => window.location.reload(),
      error: () => window.location.reload(),
    });
  }

  // Connect to the simulation once we hold a valid access token.
  private enterGame(): void {
    const token = this.auth.token;
    if (!token) {
      return;
    }
    this.started = true;
    this.store.dispatch(SimulationActions.connect({ token }));
    // Restore the player's last helm settings so a page refresh keeps the trim.
    this.restoreControls();
  }

  private authErrorMessage(status: number | undefined): string {
    if (status === 401) {
      return 'Nieprawidłowy email lub hasło.';
    }
    if (status === 409) {
      return 'Konto z tym adresem już istnieje.';
    }
    if (status === 400) {
      return 'Sprawdź dane: poprawny email i hasło min. 8 znaków.';
    }
    return 'Coś poszło nie tak. Spróbuj ponownie.';
  }

  private tickControls(dt: number): void {
    let next = this.controls;

    // Cannons charge up the longer their arrow key is held.
    if (this.chargingSide) {
      this.chargeLevel = this.clamp((performance.now() - this.chargeStart) / this.CHARGE_TIME_MS, 0, 1);
    }

    // --- Rudder: deflect while held, spring back to centre when released ---
    // A = skret w lewo (port), D = skret w prawo (starboard). Backend traktuje
    // dodatni rudder jako obrot zgodny z ruchem wskazowek zegara na ekranie
    // (czyli w prawo z perspektywy gracza), wiec D dodaje, A odejmuje.
    let rudder = next.rudder;
    const left = this.pressed.has('a');
    const right = this.pressed.has('d');
    if (left && !right) {
      rudder = this.clamp(rudder - this.RUDDER_RATE * dt, -1, 1);
    } else if (right && !left) {
      rudder = this.clamp(rudder + this.RUDDER_RATE * dt, -1, 1);
    } else {
      rudder = this.springToZero(rudder, this.RUDDER_RETURN * dt);
    }

    // --- Mainsail: G deploys, Shift+G reefs; W/S trim the mainsheet (talia) ---
    const reef = this.pressed.has('shift');
    let main = next.main;
    if (this.pressed.has('g')) {
      const delta = (reef ? -1 : 1) * this.DEPLOY_RATE * dt;
      main = { ...main, deploy: this.clamp(main.deploy + delta, 0, 1) };
    }

    // --- Jib: F deploys, Shift+F reefs; E hauls and Q eases the sheet.
    // The jib is self-tacking: it always sits on the leeward side automatically. ---
    let jib = next.jib;
    if (this.pressed.has('f')) {
      const delta = (reef ? -1 : 1) * this.DEPLOY_RATE * dt;
      jib = { ...jib, deploy: this.clamp(jib.deploy + delta, 0, 1) };
    }

    if (this.autoTrim) {
      // Auto-trim assist: drive both sheets toward the optimum for this course.
      const windFrom = this.windDir + 180;
      const beta = this.angleDiff(this.playerHeading, windFrom);
      const target = this.clamp(1 - (beta - 30) / 130, 0, 1);
      main = { ...main, sheet: this.approach(main.sheet, target, this.SHEET_RATE * dt) };
      jib = { ...jib, sheet: this.approach(jib.sheet, target, this.SHEET_RATE * dt) };
    } else {
      // Manual sheets: W/S for the mainsail, E/Q for the jib.
      if (this.pressed.has('w')) {
        main = { ...main, sheet: this.clamp(main.sheet + this.SHEET_RATE * dt, 0, 1) };
      }
      if (this.pressed.has('s')) {
        main = { ...main, sheet: this.clamp(main.sheet - this.SHEET_RATE * dt, 0, 1) };
      }
      if (this.pressed.has('e')) {
        jib = { ...jib, sheet: this.clamp(jib.sheet + this.SHEET_RATE * dt, 0, 1) };
      }
      if (this.pressed.has('q')) {
        jib = { ...jib, sheet: this.clamp(jib.sheet - this.SHEET_RATE * dt, 0, 1) };
      }
    }

    // Jib side: self-tacking on a reach. On a run the side is set by hand with M
    // ("na motyla") and held by the whisker pole, so it does NOT auto-flip on a
    // gybe - only the main comes across, blanketing the fixed-side jib until it
    // is re-winged. Leaving the run zone clears the pole back to self-tacking.
    const jibLateral = Math.sin(this.deg2rad(this.windDir - this.playerHeading));
    const leewardSide = jibLateral >= 0 ? 1 : -1;
    if (this.inButterflyZone() && jib.deploy >= 0.05) {
      const side = this.jibWing !== 0 ? this.jibWing : leewardSide;
      jib = { ...jib, side };
    } else {
      this.jibWing = 0;
      jib = { ...jib, side: jib.deploy < 0.05 || jib.sheet < 0.05 ? 0 : leewardSide };
    }

    next = { ...next, rudder, main, jib };
    this.controls = next;
    this.recomputeAndDispatch();
  }

  private recomputeAndDispatch(): void {
    const drive = this.computeDrive(this.controls);
    this.mainThrust = drive.mainThrust;
    this.jibThrust = drive.jibThrust;
    this.mainState = drive.mainState;
    this.jibState = drive.jibState;
    this.pointOfSail = drive.pointOfSail;

    const rudderRad = this.deg2rad(this.controls.rudder * this.MAX_RUDDER_DEG);
    const flow = Math.min(1, this.playerSpeed / 0.8);
    this.rudderWork = Math.abs(Math.sin(2 * rudderRad)) * flow;
    this.rudderBraking = Math.abs(this.controls.rudder) > 0.78;

    // Heel: lateral component of the rig force pushing the boat to leeward.
    const lateral = Math.sin(this.deg2rad(this.windDir - this.playerHeading));
    const leewardSign = lateral >= 0 ? 1 : -1;
    const force = drive.mainPower + Math.max(0, drive.jibPower);
    this.heel = this.clamp(leewardSign * force * Math.abs(lateral), -1, 1);

    const controls: HelmControlState = { ...this.controls, sailTrim: drive.sailTrim };
    this.controls = controls;

    // Only push to the store/WS when something meaningfully changed.
    if (
      Math.abs(controls.rudder - this.lastSent.rudder) > 0.004 ||
      Math.abs(controls.sailTrim - this.lastSent.sailTrim) > 0.004 ||
      controls.anchored !== this.lastSent.anchored
    ) {
      this.lastSent = {
        rudder: controls.rudder,
        sailTrim: controls.sailTrim,
        anchored: controls.anchored,
      };
      this.store.dispatch(SimulationActions.controlsChanged({ controls }));
    }

    this.persistControls();
  }

  // Persist the full helm state (per user) so a page reload restores it instead
  // of snapping the control deck back to zero while the boat sails on.
  private persistControls(): void {
    const user = this.auth.currentUser;
    if (!user) {
      return;
    }
    try {
      localStorage.setItem(
        `${this.CONTROLS_KEY}.${user.id}`,
        JSON.stringify({ controls: this.controls, autoTrim: this.autoTrim, jibWing: this.jibWing })
      );
    } catch {
      /* localStorage unavailable: skip persistence. */
    }
  }

  private restoreControls(): void {
    const user = this.auth.currentUser;
    if (!user) {
      return;
    }
    try {
      const raw = localStorage.getItem(`${this.CONTROLS_KEY}.${user.id}`);
      if (!raw) {
        return;
      }
      const saved = JSON.parse(raw) as { controls?: HelmControlState; autoTrim?: boolean; jibWing?: number };
      if (saved.controls) {
        this.controls = saved.controls;
        this.lastSent = {
          rudder: saved.controls.rudder,
          sailTrim: saved.controls.sailTrim,
          anchored: saved.controls.anchored,
        };
        this.store.dispatch(SimulationActions.controlsChanged({ controls: saved.controls }));
      }
      if (typeof saved.autoTrim === 'boolean') {
        this.autoTrim = saved.autoTrim;
      }
      if (typeof saved.jibWing === 'number') {
        this.jibWing = saved.jibWing;
      }
    } catch {
      /* Corrupt/unavailable storage: fall back to defaults. */
    }
  }

  private computeDrive(controls: HelmControlState): {
    sailTrim: number;
    mainThrust: number;
    jibThrust: number;
    mainPower: number;
    jibPower: number;
    mainState: SailVisualState;
    jibState: SailVisualState;
    pointOfSail: PointOfSail;
  } {
    const heading = this.playerHeading;
    // Angle between the bow and the direction the wind is coming FROM.
    // 0 = head to wind, 45 = close-hauled, 90 = beam reach, 180 = dead run.
    const windFrom = this.windDir + 180;
    const beta = this.angleDiff(heading, windFrom);

    const pointOfSail = this.classifyPointOfSail(beta);
    const inIrons = beta < 32;

    // Optimal sheet position for the current point of sail:
    // close-hauled -> ~1, beam reach -> ~0.55, run -> ~0.
    const optimalSheet = this.clamp(1 - (beta - 30) / 130, 0, 1);

    const main = this.evaluateSail({
      deploy: controls.main.deploy,
      sheet: controls.main.sheet,
      optimalSheet,
      beta,
      inIrons,
      sideOk: true,
    });

    // Jib: self-tacking on most points of sail. Dead downwind it is blanketed by
    // the main, so it luffs (stays up, no drive) unless the helm wings it out to
    // windward with M ("na motyla"), where it fills and pulls the boat downwind.
    const runZone = beta >= this.BUTTERFLY_BETA;
    let jib: { power: number; thrust: number; state: SailVisualState };
    if (controls.jib.deploy < 0.05) {
      jib = { power: 0, thrust: 0, state: 'down' };
    } else if (runZone) {
      // On a run the jib only drives when poled out to windward (opposite the
      // leeward main). Set to leeward (or after a gybe) it sits blanketed and
      // luffs without furling.
      const lateral = Math.sin(this.deg2rad(this.windDir - heading));
      const leewardSide = lateral >= 0 ? 1 : -1;
      const winged = controls.jib.side !== 0 && controls.jib.side === -leewardSide;
      if (winged) {
        const area = controls.jib.deploy;
        jib = { power: area * 0.5, thrust: area * 0.9, state: 'trim' };
      } else {
        jib = { power: 0, thrust: 0, state: 'luff' };
      }
    } else {
      // A raised jib (deploy >= 0.05) is never furled by trim alone: dumping the
      // sheet makes it luff, it does not roll the sail away. evaluateSail already
      // returns 'luff' for a slack sheet, so the jib stays visible on every point
      // of sail instead of briefly vanishing when the sheet is eased right out.
      jib = this.evaluateSail({
        deploy: controls.jib.deploy,
        sheet: controls.jib.sheet,
        optimalSheet,
        beta,
        inIrons,
        sideOk: true,
      });
    }

    // sailTrim is how much sail is actually drawing (area x trim quality). The
    // server applies the point-of-sail speed polar, so we keep this angle-free.
    // Main carries most of the drive; reefing either sail always slows the boat
    // because the two are blended rather than saturated.
    const sailTrim = this.clamp(main.thrust * 0.6 + jib.thrust * 0.4, 0, 1);
    return {
      sailTrim,
      mainThrust: main.thrust,
      jibThrust: jib.thrust,
      mainPower: main.power,
      jibPower: jib.power,
      mainState: main.state,
      jibState: jib.state,
      pointOfSail,
    };
  }

  // Per-sail trim model: returns the visual state plus the forward drive (thrust)
  // and absolute lateral power (used for heel calculations).
  private evaluateSail(args: {
    deploy: number;
    sheet: number;
    optimalSheet: number;
    beta: number;
    inIrons: boolean;
    sideOk: boolean;
  }): { power: number; thrust: number; state: SailVisualState } {
    if (args.deploy < 0.05) {
      return { power: 0, thrust: 0, state: 'down' };
    }
    if (args.inIrons) {
      return { power: 0, thrust: 0, state: 'luff' };
    }

    const diff = args.sheet - args.optimalSheet;
    // Sail area projected forward: full when properly trimmed, falls off when over-sheeted (stalled).
    const projection = Math.sin(this.deg2rad(args.beta));

    if (diff < -0.18) {
      // Sheet too loose for this point of sail: sail luffs and produces no thrust.
      return { power: 0, thrust: 0, state: 'luff' };
    }
    if (diff > 0.28) {
      // Sheet hauled past the optimum: sail stalls, big drag, little thrust.
      const stallArea = args.deploy * 0.4;
      return { power: stallArea * projection, thrust: stallArea * 0.5, state: 'stall' };
    }

    // Sweet spot: working sail area = deploy (reef) x how close the sheet is to
    // the optimum. Angle independent on purpose; the server polar adds the
    // point-of-sail shaping. power keeps the projection term for heel/visuals.
    const quality = 1 - Math.abs(diff) / 0.25;
    const area = args.deploy * this.clamp(quality, 0, 1);
    const power = area * (0.5 + 0.5 * projection);
    return { power, thrust: area, state: 'trim' };
  }

  private classifyPointOfSail(beta: number): PointOfSail {
    if (beta < 30) return 'irons';      // W LINII WIATRU
    if (beta < 50) return 'closehaul';  // OSTRY BAJDEWIND
    if (beta < 75) return 'close';      // BAJDEWIND
    if (beta < 105) return 'beam';      // POLWIATR
    if (beta < 140) return 'broad';     // BAKSZTAG
    if (beta < 168) return 'deeprun';   // PELNY BAKSZTAG
    return 'run';                       // FORDEWIND
  }

  private springToZero(value: number, step: number): number {
    if (Math.abs(value) <= step) {
      return 0;
    }
    return value - Math.sign(value) * step;
  }

  private approach(value: number, target: number, step: number): number {
    if (Math.abs(target - value) <= step) {
      return target;
    }
    return value + Math.sign(target - value) * step;
  }

  private inButterflyZone(): boolean {
    const windFrom = this.windDir + 180;
    return this.angleDiff(this.playerHeading, windFrom) >= this.BUTTERFLY_BETA;
  }

  private angleDiff(a: number, b: number): number {
    const d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  }

  private deg2rad(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
