export interface BoatState {
  boatId: string;
  name?: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  rudder: number;
  sailTrim: number;
  anchored?: boolean;
  health?: number;
  sunk?: boolean;
  kills?: number;
  deaths?: number;
  bot?: boolean;
  // Server-computed heel angle in degrees (signed) and capsize (knockdown) flag.
  heel?: number;
  capsized?: boolean;
}

export type FireSide = 'port' | 'starboard';

export type LakeSize = 'SMALL' | 'MEDIUM' | 'LARGE';

export interface LakeSummary {
  id: string;
  name: string;
  size: LakeSize;
  boats: number;
  capacity: number;
  bots: boolean;
}

export interface Projectile {
  id: string;
  ownerId: string;
  x: number;
  y: number;
}

export interface Buoy {
  id: string;
  x: number;
  y: number;
}

export interface IslandPoint {
  x: number;
  y: number;
}

export interface Island {
  id: string;
  points: IslandPoint[];
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
  heelLoad?: number; // how hard the sails are sheeted/loaded 0..1 (drives heel)
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
  buoys?: Buoy[];
  islands?: Island[];
  yourBoatId?: string;
  worldWidth?: number;
  worldHeight?: number;
  lakeId?: string;
  lakeName?: string;
  lakeBoats?: number;
  lakeCapacity?: number;
  lakeTotal?: number;
  lakes?: LakeSummary[];
}

export interface SimulationState {
  connected: boolean;
  controls: HelmControlState;
  boats: BoatState[];
  projectiles: Projectile[];
  buoys: Buoy[];
  islands: Island[];
  playerBoatId: string | null;
  windDirection: number;
  windStrength: number;
  worldWidth: number;
  worldHeight: number;
  lakeId: string | null;
  lakeName: string | null;
  lakeBoats: number;
  lakeCapacity: number;
  lakeTotal: number;
  lakes: LakeSummary[];
}
