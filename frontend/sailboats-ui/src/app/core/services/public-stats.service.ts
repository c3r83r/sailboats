import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, Subject, catchError, forkJoin, map, merge, of, shareReplay, switchMap, timer } from 'rxjs';
import { environment } from '../../../environments/environment';

interface AuthStats {
  registeredUsers: number;
  activeUsers: number;
  activeWindowHours: number;
}

interface SimulationStats {
  onlineUsers: number;
}

export interface PublicStats extends AuthStats, SimulationStats {}

@Injectable({ providedIn: 'root' })
export class PublicStatsService {
  private readonly authBase = environment.apiBaseUrl;
  private readonly simulationBase = environment.simulationApiBaseUrl;

  // Lets callers (e.g. right after login/logout) force an immediate refetch
  // instead of waiting for the next periodic tick.
  private readonly manualRefresh$ = new Subject<void>();

  constructor(private readonly http: HttpClient) {}

  readonly stats$: Observable<PublicStats> = merge(timer(0, 15000), this.manualRefresh$).pipe(
    switchMap(() =>
      forkJoin({
        auth: this.http.get<AuthStats>(`${this.authBase}/api/auth/public/stats`),
        simulation: this.http
          .get<SimulationStats>(`${this.simulationBase}/api/simulation/public/stats`)
          .pipe(catchError(() => of({ onlineUsers: 0 }))),
      }).pipe(
        map(({ auth, simulation }) => ({
          registeredUsers: auth.registeredUsers,
          activeUsers: auth.activeUsers,
          activeWindowHours: auth.activeWindowHours,
          onlineUsers: simulation.onlineUsers,
        })),
        catchError(() => of({ registeredUsers: 0, activeUsers: 0, activeWindowHours: 24, onlineUsers: 0 }))
      )
    ),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  /** Forces an immediate stats refetch (e.g. right after the player joins/leaves). */
  refresh(): void {
    this.manualRefresh$.next();
  }
}