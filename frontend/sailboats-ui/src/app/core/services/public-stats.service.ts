import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, shareReplay, switchMap, timer } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface PublicStats {
  registeredUsers: number;
  activeUsers: number;
  activeWindowHours: number;
}

@Injectable({ providedIn: 'root' })
export class PublicStatsService {
  private readonly base = environment.apiBaseUrl;

  constructor(private readonly http: HttpClient) {}

  readonly stats$: Observable<PublicStats> = timer(0, 30000).pipe(
    switchMap(() => this.http.get<PublicStats>(`${this.base}/api/auth/public/stats`)),
    shareReplay({ bufferSize: 1, refCount: true })
  );
}