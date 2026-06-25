import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { FireSide, HelmControlState, LakeSize, SimulationSnapshot } from './simulation.models';

export const SimulationActions = createActionGroup({
  source: 'Simulation',
  events: {
    Connect: props<{ token: string }>(),
    Connected: emptyProps(),
    Disconnected: emptyProps(),
    'Snapshot Received': props<{ snapshot: SimulationSnapshot }>(),
    'Controls Changed': props<{ controls: HelmControlState }>(),
    Fire: props<{ side: FireSide; power: number }>(),
    'Join Lake': props<{ lakeId: string }>(),
    'Create Lake': props<{ size: LakeSize; bots: boolean; windDirection: number | null; name: string }>(),
  },
});
