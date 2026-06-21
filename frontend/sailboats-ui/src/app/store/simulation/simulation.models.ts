export interface BoatState {
  boatId: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  rudder: number;
  sailTrim: number;
  anchored?: boolean;
  health?: number;
  sunk?: boolean;
}

export type FireSide = 'bow' | 'stern' | 'port' | 'starboard';

export interface Projectile {
  id: string;
  ownerId: string;
  x: number;
  y: number;
}

export type SailSlot = 'jib' | 'main';

export interface SailControl {
  deploy: number; // 0 = furled/down, 1 = fully set
  sheet: number; // 0 = eased/luffing, 1 = sheeted hard
  side: number; // -1 port sheet, 0 none, +1 starboard sheet (jib only)
}

export interface HelmControlState {
  rudder: number; // -1 = full left (A), +1 = full right (D)
  sailTrim: number; // computed forward drive 0..1 sent to the backend
  jib: SailControl;
  main: SailControl;
  anchored: boolean; // K key: anchor down -> boat held bow-into-wind
}

export interface SimulationSnapshot {
  serverTime: number;
  windDirection: number;
  windStrength: number;
  boats: BoatState[];
  projectiles?: Projectile[];
  yourBoatId?: string;
}

export interface SimulationState {
  connected: boolean;
  controls: HelmControlState;
  boats: BoatState[];
  projectiles: Projectile[];
  playerBoatId: string | null;
  windDirection: number;
  windStrength: number;
}
