import { AsyncPipe, CommonModule } from '@angular/common';
import { Component, DestroyRef, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { combineLatest } from 'rxjs';
import { ControlPanelComponent } from './features/simulation/components/control-panel/control-panel.component';
import { WaterCanvasComponent } from './features/simulation/components/water-canvas/water-canvas.component';
import { Scene3dComponent } from './features/simulation/components/scene-3d/scene-3d.component';
import { AuthService } from './core/services/auth.service';
import { PublicStatsService } from './core/services/public-stats.service';
import { SimulationWsService } from './core/services/simulation-ws.service';
import { SimulationActions } from './store/simulation/simulation.actions';
import { selectBoats, selectBuoys, selectConnected, selectControls, selectIslands, selectLake, selectLakes, selectPlayerBoatId, selectProjectiles, selectWind, selectWorld } from './store/simulation/simulation.selectors';
import { BoatState, FireSide, HelmControlState, LakeSize, LakeSummary } from './store/simulation/simulation.models';

export type SailVisualState = 'down' | 'luff' | 'trim' | 'stall' | 'back';
export type PointOfSail = 'irons' | 'closehaul' | 'close' | 'beam' | 'broad' | 'deeprun' | 'run';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, AsyncPipe, FormsModule, ControlPanelComponent, WaterCanvasComponent, Scene3dComponent],
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

      <div class="lake-browser" *ngIf="showLakeBrowser">
        <div class="browser-card" *ngIf="!showCreatePanel">
          <div class="browser-head">
            <h2>Wybierz akwen</h2>
            <button type="button" class="browser-close" (click)="closeLakeBrowser()">✕</button>
          </div>
          <div class="browser-cols">
            <div class="browser-col" *ngFor="let col of sizeColumns">
              <h3>{{ col.label }}</h3>
              <ul class="lake-list">
                <li
                  *ngFor="let l of lakesOf(col.size)"
                  [class.current]="l.id === currentLakeId"
                  (click)="joinLake(l.id)">
                  <span class="ll-name">{{ l.name }}</span>
                  <span class="ll-meta">{{ l.boats }}/{{ l.capacity }} · {{ l.bots ? 'boty' : 'bez botów' }}</span>
                </li>
                <li class="ll-empty" *ngIf="lakesOf(col.size).length === 0">brak akwenów</li>
              </ul>
              <button type="button" class="new-btn" (click)="openCreatePanel(col.size)">+ Nowy</button>
            </div>
          </div>
        </div>

        <div class="browser-card create" *ngIf="showCreatePanel">
          <div class="browser-head">
            <h2>Nowy akwen — {{ createSizeLabel }}</h2>
            <button type="button" class="browser-close" (click)="backToBrowser()">✕</button>
          </div>
          <label class="create-row create-name">
            <span>Nazwa</span>
            <input
              type="text"
              name="createName"
              [(ngModel)]="createName"
              maxlength="30"
              placeholder="Nazwa akwenu"
              autocomplete="off" />
          </label>
          <label class="create-row">
            <input type="checkbox" name="createBots" [(ngModel)]="createBots" />
            <span>Boty na akwenie</span>
          </label>
          <label class="create-row create-wind">
            <span>Kierunek wiatru</span>
            <select name="createWind" [(ngModel)]="createWind">
              <option *ngFor="let w of windOptions" [ngValue]="w.value">{{ w.label }}</option>
            </select>
          </label>
          <p class="create-hint">Więcej opcji (wielkość i liczba wysp, tryb regat…) pojawi się tutaj wkrótce.</p>
          <div class="create-actions">
            <button type="button" class="secondary" (click)="backToBrowser()">Wstecz</button>
            <button type="button" class="primary" (click)="createLake()">Stwórz i wpłyń</button>
          </div>
        </div>
      </div>

      <header>
        <div class="brand">
          <h1>Sailboats</h1>
          <p>Multiplayer real-time sailing simulator</p>
        </div>
        <div class="public-stats" *ngIf="publicStats$ | async as stats">
          <div class="stat-pill">
            <span class="stat-value">{{ stats.registeredUsers }}</span>
            <span class="stat-label">zarejestrowanych</span>
          </div>
          <div class="stat-pill accent">
            <span class="stat-value">{{ stats.activeUsers }}</span>
            <span class="stat-label">aktywnych / {{ stats.activeWindowHours }}h</span>
          </div>
          <div class="stat-pill live">
            <span class="stat-value">{{ stats.onlineUsers }}</span>
            <span class="stat-label">online teraz</span>
          </div>
        </div>
        <div class="lake" *ngIf="lake$ | async as lake">
          <span class="lake-name">{{ lake.name ?? 'Akwen' }}</span>
          <span class="lake-count">{{ lake.boats }}/{{ lake.capacity }} łódek</span>
          <button type="button" class="lake-btn" (click)="openLakeBrowser()" [disabled]="(connected$ | async) !== true">
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

      <section class="content" [class.fullscreen]="fullscreen">
        <aside class="info-panel">
          <div class="ip-section">
            <h3 class="ip-lake">{{ (lake$ | async)?.name ?? 'Akwen' }}</h3>
            <p class="ip-sub">{{ (lake$ | async)?.boats ?? 0 }} łódek graczy</p>
          </div>

          <div class="ip-section ip-compass">
            <div class="compass">
              <span class="c-card c-n">N</span>
              <span class="c-card c-e">E</span>
              <span class="c-card c-s">S</span>
              <span class="c-card c-w">W</span>
              <div class="needle" [style.transform]="'rotate(' + (windDirection + 90) + 'deg)'"></div>
            </div>
            <span class="ip-label">Wiatr</span>
          </div>

          <div class="ip-section ip-scores">
            <div class="ip-scores-head"><span>Gracz</span><span title="Zabójstwa">Z</span><span title="Śmierci">Ś</span></div>
            <div class="ip-row" *ngFor="let p of players" [class.me]="p.boatId === playerBoatId">
              <span class="ip-name">{{ p.name ?? p.boatId }}</span>
              <span>{{ p.kills ?? 0 }}</span>
              <span>{{ p.deaths ?? 0 }}</span>
            </div>
            <p class="ip-empty" *ngIf="!players.length">brak graczy</p>
          </div>
        </aside>

        <div class="canvas-stage">
          <app-water-canvas
            *ngIf="viewMode === '2d'"
            [boats]="(boats$ | async) ?? []"
            [projectiles]="(projectiles$ | async) ?? []"
            [buoys]="(buoys$ | async) ?? []"
            [islands]="(islands$ | async) ?? []"
            [worldWidth]="((world$ | async)?.width) ?? 28"
            [worldHeight]="((world$ | async)?.height) ?? 15.75"
            [windDirection]="windDirection"
            [windStrength]="windStrength"
            [fill]="fullscreen"
            [controls]="controls"
            [playerBoatId]="playerBoatId"
            [mainState]="mainState"
            [jibState]="jibState"
            [heel]="heel">
          </app-water-canvas>
          <app-scene-3d
            *ngIf="viewMode === '3d'"
            [boats]="(boats$ | async) ?? []"
            [projectiles]="(projectiles$ | async) ?? []"
            [buoys]="(buoys$ | async) ?? []"
            [islands]="(islands$ | async) ?? []"
            [worldWidth]="((world$ | async)?.width) ?? 28"
            [worldHeight]="((world$ | async)?.height) ?? 15.75"
            [windDirection]="windDirection"
            [windStrength]="windStrength"
            [fill]="fullscreen"
            [controls]="controls"
            [playerBoatId]="playerBoatId">
          </app-scene-3d>
          <button
            type="button"
            class="view-toggle"
            (click)="toggleViewMode()"
            [title]="viewMode === '2d' ? 'Przełącz na widok 3D' : 'Przełącz na widok 2D'">
            {{ viewMode === '2d' ? '3D' : '2D' }}
          </button>
          <button
            type="button"
            class="fs-btn"
            (click)="toggleFullscreen()"
            [title]="fullscreen ? 'Wyjdź z pełnego ekranu' : 'Pełny ekran'"
            aria-label="Pełny ekran">
            <svg *ngIf="!fullscreen" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            <svg *ngIf="fullscreen" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8V6a1 1 0 0 1 1-1h2M19 8V6a1 1 0 0 0-1-1h-2M5 16v2a1 1 0 0 0 1 1h2M19 16v2a1 1 0 0 1-1 1h-2"/></svg>
          </button>
        </div>

        <app-control-panel
          [overlay]="fullscreen"
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
      backdrop-filter: blur(6px);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
    }
    .status.online {
      background: rgba(31, 143, 87, 0.9);
    }

    .public-stats {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-left: auto;
    }

    .stat-pill {
      min-width: 128px;
      padding: 10px 14px;
      border-radius: 16px;
      background: rgba(6, 24, 41, 0.68);
      border: 1px solid rgba(143, 227, 255, 0.14);
      display: grid;
      gap: 2px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
    }

    .stat-pill.accent {
      background: linear-gradient(135deg, rgba(16, 102, 140, 0.85), rgba(8, 47, 74, 0.92));
      border-color: rgba(143, 227, 255, 0.2);
    }

    .stat-pill.live {
      background: linear-gradient(135deg, rgba(30, 138, 86, 0.88), rgba(9, 50, 33, 0.94));
      border-color: rgba(163, 244, 194, 0.22);
    }

    .stat-value {
      font-size: 1.2rem;
      font-weight: 800;
      color: #f4fbff;
      line-height: 1;
    }

    .stat-label {
      font-size: 0.76rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(216, 244, 255, 0.78);
    }

    .lake {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(11, 38, 62, 0.55);
      border: 1px solid rgba(143, 227, 255, 0.14);
      border-radius: 999px;
      padding: 5px 6px 5px 16px;
      backdrop-filter: blur(6px);
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

    .lake-browser {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(2, 8, 16, 0.78);
      backdrop-filter: blur(3px);
    }

    .browser-card {
      width: min(920px, 94vw);
      max-height: 88vh;
      overflow: auto;
      padding: 22px 24px;
      border-radius: 16px;
      border: 1px solid rgba(143, 227, 255, 0.3);
      background: rgba(8, 18, 30, 0.97);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }

    .browser-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }

    .browser-head h2 {
      margin: 0;
      font-size: 1.2rem;
    }

    .browser-close {
      background: none;
      border: none;
      color: #9fc7df;
      font-size: 1.1rem;
      cursor: pointer;
    }

    .browser-cols {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }

    .browser-col {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(12, 26, 40, 0.7);
      border: 1px solid rgba(143, 227, 255, 0.16);
    }

    .browser-col h3 {
      margin: 0;
      text-align: center;
      font-size: 1rem;
      letter-spacing: 0.04em;
      color: #cfeeff;
    }

    .lake-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 60px;
    }

    .lake-list li {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(8, 18, 30, 0.8);
      border: 1px solid rgba(143, 227, 255, 0.18);
      cursor: pointer;
      transition: filter 0.12s ease;
    }

    .lake-list li:hover:not(.ll-empty) {
      filter: brightness(1.25);
    }

    .lake-list li.current {
      border-color: rgba(255, 209, 102, 0.7);
      box-shadow: inset 0 0 0 1px rgba(255, 209, 102, 0.4);
    }

    .ll-name {
      font-weight: 700;
      font-size: 0.9rem;
    }

    .ll-meta {
      font-size: 0.75rem;
      color: #9fc7df;
    }

    .ll-empty {
      cursor: default;
      text-align: center;
      color: #6f8aa0;
      font-size: 0.8rem;
      background: none;
      border: 1px dashed rgba(143, 227, 255, 0.18);
    }

    .new-btn {
      margin-top: auto;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid rgba(143, 227, 255, 0.4);
      background: rgba(143, 227, 255, 0.14);
      color: #eaf6ff;
      font-weight: 700;
      cursor: pointer;
    }

    .new-btn:hover {
      filter: brightness(1.2);
    }

    .create-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 0.95rem;
      margin: 6px 0;
    }

    .create-hint {
      color: #8fb6cc;
      font-size: 0.82rem;
      margin: 4px 0 16px;
    }

    .create-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    .create-actions .secondary,
    .create-actions .primary {
      padding: 9px 16px;
      border-radius: 9px;
      cursor: pointer;
      font-weight: 700;
      border: 1px solid rgba(143, 227, 255, 0.35);
    }

    .create-actions .secondary {
      background: rgba(8, 18, 30, 0.7);
      color: #cfeeff;
    }

    .create-actions .primary {
      background: linear-gradient(90deg, rgba(143, 227, 255, 0.3), rgba(255, 209, 102, 0.3));
      color: #eaf6ff;
    }

    .create-wind {
      justify-content: space-between;
    }

    .create-wind select {
      padding: 6px 8px;
      border-radius: 8px;
      background: rgba(8, 18, 30, 0.9);
      color: #eaf6ff;
      border: 1px solid rgba(143, 227, 255, 0.35);
    }

    .create-name {
      justify-content: space-between;
    }

    .create-name input {
      padding: 6px 8px;
      border-radius: 8px;
      background: rgba(8, 18, 30, 0.9);
      color: #eaf6ff;
      border: 1px solid rgba(143, 227, 255, 0.35);
      width: 170px;
      outline: none;
    }

    @media (max-width: 720px) {
      .browser-cols {
        grid-template-columns: 1fr;
      }
    }

    .content {
      display: grid;
      gap: 18px;
      grid-template-columns: 230px minmax(0, 1fr) 340px;
      align-items: start;
    }

    .canvas-stage {
      position: relative;
      min-width: 0;
    }

    .canvas-stage app-water-canvas {
      display: block;
      width: 100%;
    }

    .content.fullscreen app-water-canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    .fs-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 5;
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      border-radius: 10px;
      border: 1px solid rgba(143, 227, 255, 0.35);
      background: rgba(8, 24, 40, 0.55);
      color: #d8f4ff;
      cursor: pointer;
      backdrop-filter: blur(6px);
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .fs-btn:hover {
      background: rgba(143, 227, 255, 0.22);
      transform: translateY(-1px);
    }

    .view-toggle {
      position: absolute;
      top: 12px;
      right: 58px;
      z-index: 5;
      height: 38px;
      min-width: 42px;
      padding: 0 12px;
      display: grid;
      place-items: center;
      border-radius: 10px;
      border: 1px solid rgba(143, 227, 255, 0.35);
      background: rgba(8, 24, 40, 0.55);
      color: #d8f4ff;
      font-weight: 800;
      letter-spacing: 0.06em;
      font-size: 0.82rem;
      cursor: pointer;
      backdrop-filter: blur(6px);
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .view-toggle:hover {
      background: rgba(143, 227, 255, 0.22);
      transform: translateY(-1px);
    }

    /* Fullscreen: lake fills the viewport, panels float semi-transparent over it. */
    .content.fullscreen {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: block;
      gap: 0;
      background: var(--bg-deep, #05243f);
    }

    .content.fullscreen .canvas-stage {
      position: absolute;
      inset: 0;
    }

    .content.fullscreen .info-panel {
      position: absolute;
      top: 14px;
      left: 14px;
      width: 232px;
      max-height: calc(100vh - 28px);
      overflow: auto;
      z-index: 4;
      background: rgba(8, 24, 40, 0.42);
      backdrop-filter: blur(12px);
    }

    .content.fullscreen app-control-panel {
      position: absolute;
      top: 64px;
      right: 14px;
      width: 340px;
      max-height: calc(100vh - 78px);
      overflow: auto;
      z-index: 4;
    }

    .info-panel {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 14px;
      border-radius: 16px;
      background: rgba(11, 38, 62, 0.55);
      border: 1px solid rgba(143, 227, 255, 0.14);
      backdrop-filter: blur(6px);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
    }

    .ip-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .ip-lake {
      margin: 0;
      font-size: 1.05rem;
      color: #eaf6ff;
    }

    .ip-sub {
      margin: 0;
      font-size: 0.82rem;
      color: #9fc7df;
    }

    .ip-compass {
      align-items: center;
      gap: 6px;
    }

    .compass {
      position: relative;
      width: 92px;
      height: 92px;
      border-radius: 50%;
      border: 2px solid rgba(143, 227, 255, 0.4);
      background: radial-gradient(circle, rgba(12, 26, 40, 0.9), rgba(8, 18, 30, 0.95));
    }

    .c-card {
      position: absolute;
      font-size: 0.7rem;
      color: #9fc7df;
      transform: translate(-50%, -50%);
    }

    .c-n { left: 50%; top: 11px; }
    .c-s { left: 50%; top: calc(100% - 11px); }
    .c-e { left: calc(100% - 10px); top: 50%; }
    .c-w { left: 10px; top: 50%; }

    .needle {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-bottom: 34px solid #ffd166;
      transform-origin: 50% 100%;
      margin: -34px 0 0 -6px;
    }

    .ip-label {
      font-size: 0.78rem;
      color: #9fc7df;
      letter-spacing: 0.05em;
    }

    .ip-scores {
      gap: 4px;
    }

    .ip-scores-head,
    .ip-row {
      display: grid;
      grid-template-columns: 1fr 22px 22px;
      gap: 6px;
      font-size: 0.82rem;
      align-items: center;
    }

    .ip-scores-head {
      color: #7f9bb0;
      font-size: 0.72rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 4px;
    }

    .ip-row.me .ip-name {
      color: #ffe19a;
      font-weight: 700;
    }

    .ip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ip-empty {
      color: #6f8aa0;
      font-size: 0.78rem;
      margin: 4px 0 0;
    }

    @media (max-width: 980px) {
      .content {
        grid-template-columns: 1fr;
      }
    }

    .kbd-help {
      margin: 0;
      padding: 11px 14px;
      border-radius: 12px;
      background: rgba(11, 38, 62, 0.62);
      border: 1px solid rgba(143, 227, 255, 0.18);
      backdrop-filter: blur(6px);
      font-size: 0.86rem;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      align-items: center;
    }

    .kbd-help span { opacity: 0.95; }

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

      .public-stats {
        margin-left: 0;
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
  private readonly publicStats = inject(PublicStatsService);
  private readonly ws = inject(SimulationWsService);

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
  // Fullscreen mode: lake fills the screen, side panels float over it.
  fullscreen = false;
  // Rendering view: flat top-down 2D canvas or the WebGL 3D scene (toggle).
  viewMode: '2d' | '3d' = '2d';
  authMode: 'login' | 'register' = 'login';
  email = '';
  password = '';
  displayName = '';
  authError = '';
  authBusy = false;
  publicStats$ = this.publicStats.stats$;

  // Lake browser overlay.
  showLakeBrowser = false;
  showCreatePanel = false;
  createSize: LakeSize = 'SMALL';
  createBots = true;
  createName = '';
  lakes: LakeSummary[] = [];
  currentLakeId: string | null = null;
  readonly sizeColumns: { size: LakeSize; label: string }[] = [
    { size: 'SMALL', label: 'Małe' },
    { size: 'MEDIUM', label: 'Średnie' },
    { size: 'LARGE', label: 'Duże' },
  ];
  createWind: number | null = null;
  readonly windOptions: { label: string; value: number | null }[] = [
    { label: 'Losowy', value: null },
    { label: 'Płn (N)', value: 90 },
    { label: 'Płn-wsch (NE)', value: 135 },
    { label: 'Wsch (E)', value: 180 },
    { label: 'Płd-wsch (SE)', value: 225 },
    { label: 'Płd (S)', value: 270 },
    { label: 'Płd-zach (SW)', value: 315 },
    { label: 'Zach (W)', value: 0 },
    { label: 'Płn-zach (NW)', value: 45 },
  ];
  // Wind direction for the side-panel compass.
  windDirection = 0;
  // Gusted wind strength (drives the wind-line speed/brightness on the canvas).
  windStrength = 5;
  // All boats from the last snapshot (used to build the player scoreboard).
  boatsList: BoatState[] = [];

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
  world$ = this.store.select(selectWorld);

  // Wind blows straight down the screen (matches the backend constant).
  // Live wind direction of the current lake (each lake can differ / be random).
  private get windDir(): number {
    return this.windDirection;
  }
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
  // Disconnect a player who leaves the page (tab hidden) for too long.
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private awayDisconnected = false;
  private readonly AWAY_TIMEOUT_MS = 45000;

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

    this.store.select(selectLakes).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((lakes) => {
      this.lakes = lakes;
    });
    this.lake$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((lake) => {
      this.currentLakeId = lake.id;
    });
    this.wind$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((wind) => {
      this.windDirection = wind.direction;
      this.windStrength = wind.strength;
    });

    combineLatest([this.boats$, this.playerBoatId$])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([boats, playerBoatId]) => {
        this.playerBoatId = playerBoatId;
        this.boatsList = boats;
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
    // recomputes the effective drive even while the boat is turning. Uses the
    // real elapsed time so it stays smooth even when the frame budget is tight
    // (e.g. a large fullscreen canvas).
    let lastHelm = performance.now();
    this.loopHandle = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastHelm) / 1000);
      lastHelm = now;
      this.tickControls(dt);
    }, 40);
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

    // Lake browser overlay is open: don't drive the boat or fire the guns.
    if (this.showLakeBrowser) {
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

  openLakeBrowser(): void {
    this.showLakeBrowser = true;
    this.showCreatePanel = false;
    // Drop focus off the button so arrow/space keys can't re-trigger it.
    (document.activeElement as HTMLElement | null)?.blur();
  }

  closeLakeBrowser(): void {
    this.showLakeBrowser = false;
    this.showCreatePanel = false;
  }

  lakesOf(size: LakeSize): LakeSummary[] {
    return this.lakes.filter((lake) => lake.size === size);
  }

  joinLake(lakeId: string): void {
    if (lakeId !== this.currentLakeId) {
      this.store.dispatch(SimulationActions.joinLake({ lakeId }));
      this.resetControls();
    }
    this.closeLakeBrowser();
  }

  openCreatePanel(size: LakeSize): void {
    this.createSize = size;
    this.createBots = true;
    this.createWind = null;
    this.createName = '';
    this.showCreatePanel = true;
  }

  backToBrowser(): void {
    this.showCreatePanel = false;
  }

  createLake(): void {
    this.store.dispatch(
      SimulationActions.createLake({
        size: this.createSize,
        bots: this.createBots,
        windDirection: this.createWind,
        name: this.createName.trim(),
      })
    );
    this.resetControls();
    this.closeLakeBrowser();
  }

  get createSizeLabel(): string {
    return this.sizeColumns.find((col) => col.size === this.createSize)?.label ?? '';
  }

  get players(): BoatState[] {
    return this.boatsList
      .filter((boat) => !boat.bot)
      .slice()
      .sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || (a.deaths ?? 0) - (b.deaths ?? 0));
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

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    try {
      if (this.fullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen?.();
      } else if (!this.fullscreen && document.fullscreenElement) {
        document.exitFullscreen?.();
      }
    } catch {
      /* Fullscreen API unavailable: the CSS fullscreen layout still applies. */
    }
    (document.activeElement as HTMLElement | null)?.blur();
  }

  toggleViewMode(): void {
    this.viewMode = this.viewMode === '2d' ? '3d' : '2d';
    (document.activeElement as HTMLElement | null)?.blur();
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    // Keep state in sync when the user exits fullscreen via Esc / browser UI.
    if (!document.fullscreenElement && this.fullscreen) {
      this.fullscreen = false;
    }
  }

  // Disconnect players who leave the page (hidden tab) for longer than the grace
  // window, so they free their boat/slot; rejoin automatically on return.
  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.hidden) {
      if (this.started && this.awayTimer === null) {
        this.awayTimer = setTimeout(() => this.handleIdleTimeout(), this.AWAY_TIMEOUT_MS);
      }
    } else {
      if (this.awayTimer !== null) {
        clearTimeout(this.awayTimer);
        this.awayTimer = null;
      }
      if (this.awayDisconnected) {
        this.awayDisconnected = false;
        this.rejoinAfterIdle();
      }
    }
  }

  private handleIdleTimeout(): void {
    this.awayTimer = null;
    if (!this.started) {
      return;
    }
    this.awayDisconnected = true;
    this.ws.disconnect();
    this.store.dispatch(SimulationActions.disconnected());
    // Give the server a moment to drop the session, then reflect the drop in the counter.
    setTimeout(() => this.publicStats.refresh(), 500);
  }

  private rejoinAfterIdle(): void {
    // The access token may have expired while away: refresh, then reconnect.
    this.auth.refresh().subscribe({
      next: () => this.enterGame(),
      error: () => {
        this.started = false;
      },
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
    // Always start fresh: sails down + anchor (resets the boat on login/rejoin).
    this.resetControls();
    // Give the WS handshake a moment to register, then reflect the join in the counter.
    setTimeout(() => this.publicStats.refresh(), 500);
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
  }

  // Reset the helm to the start-of-game state (sails down, anchored). Called on
  // login and on every lake change so the boat always starts fresh.
  private resetControls(): void {
    const fresh: HelmControlState = {
      rudder: 0,
      sailTrim: 0,
      jib: { deploy: 0, sheet: 0, side: 0 },
      main: { deploy: 0, sheet: 0, side: 0 },
      anchored: true,
    };
    this.controls = fresh;
    this.autoTrim = false;
    this.jibWing = 0;
    this.lastSent = { rudder: 0, sailTrim: 0, anchored: true };
    this.store.dispatch(SimulationActions.controlsChanged({ controls: fresh }));
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
