import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { FireSide, HelmControlState, SimulationSnapshot } from './simulation.models';

export const SimulationActions = createActionGroup({
  source: 'Simulation',
  events: {
    Connect: props<{ nick: string }>(),
    Connected: emptyProps(),
    Disconnected: emptyProps(),
    'Snapshot Received': props<{ snapshot: SimulationSnapshot }>(),
    'Controls Changed': props<{ controls: HelmControlState }>(),
    Fire: props<{ side: FireSide; power: number }>(),
    'Change Lake': emptyProps(),
  },
});
