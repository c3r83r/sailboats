import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, map, tap } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly base = environment.apiBaseUrl;
  private accessToken: string | null = null;
  private readonly userSubject = new BehaviorSubject<AuthUser | null>(null);
  readonly user$ = this.userSubject.asObservable();

  constructor(private readonly http: HttpClient) {}

  get token(): string | null {
    return this.accessToken;
  }

  get currentUser(): AuthUser | null {
    return this.userSubject.value;
  }

  register(email: string, password: string, displayName: string): Observable<AuthUser> {
    return this.http
      .post<AuthResponse>(`${this.base}/api/auth/register`, { email, password, displayName }, { withCredentials: true })
      .pipe(map((res) => this.apply(res)));
  }

  login(email: string, password: string): Observable<AuthUser> {
    return this.http
      .post<AuthResponse>(`${this.base}/api/auth/login`, { email, password }, { withCredentials: true })
      .pipe(map((res) => this.apply(res)));
  }

  /** Exchanges the HttpOnly refresh cookie for a fresh access token (auto-login). */
  refresh(): Observable<AuthUser> {
    return this.http
      .post<AuthResponse>(`${this.base}/api/auth/refresh`, {}, { withCredentials: true })
      .pipe(map((res) => this.apply(res)));
  }

  logout(): Observable<void> {
    return this.http
      .post<void>(`${this.base}/api/auth/logout`, {}, { withCredentials: true })
      .pipe(
        tap(() => {
          this.accessToken = null;
          this.userSubject.next(null);
        })
      );
  }

  private apply(res: AuthResponse): AuthUser {
    this.accessToken = res.accessToken;
    this.userSubject.next(res.user);
    return res.user;
  }
}
