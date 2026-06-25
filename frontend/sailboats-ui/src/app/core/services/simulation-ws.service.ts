import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SimulationSnapshot } from '../../store/simulation/simulation.models';

@Injectable({ providedIn: 'root' })
export class SimulationWsService {
  private socket?: WebSocket;
  private snapshotSubject = new Subject<SimulationSnapshot>();
  private statusSubject = new Subject<'connected' | 'disconnected'>();

  connect(token: string): Observable<SimulationSnapshot> {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      const base = environment.simulationWsUrl || this.resolveWsUrl();
      const url = `${base}?token=${encodeURIComponent(token)}`;
      this.socket = new WebSocket(url);

      this.socket.onopen = () => this.statusSubject.next('connected');
      this.socket.onclose = () => this.statusSubject.next('disconnected');
      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as SimulationSnapshot;
        this.snapshotSubject.next(data);
      };
    }

    return this.snapshotSubject.asObservable();
  }

  /** Close the connection (e.g. when the player has been idle/away too long). */
  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
  }

  status$(): Observable<'connected' | 'disconnected'> {
    return this.statusSubject.asObservable();
  }

  /**
   * Builds the WebSocket URL from the current page origin so the production
   * bundle works on any domain behind TLS (https -> wss) without a rebuild.
   */
  private resolveWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/simulation`;
  }

  sendControls(rudder: number, sailTrim: number, anchored: boolean): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // Backend simulation-service currently expects compact control payload.
    this.socket.send(JSON.stringify({ rudder, sailTrim, anchored }));
  }

  sendFire(side: string, power: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({ type: 'fire', side, power }));
  }

  sendJoinLake(lakeId: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({ type: 'joinLake', lakeId }));
  }

  sendCreateLake(size: string, bots: boolean, windDirection: number | null, name: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({ type: 'createLake', size, bots, windDirection, name }));
  }
}
