import { createReducer, on } from '@ngrx/store';
import { SimulationActions } from './simulation.actions';
import { SimulationState } from './simulation.models';

export const simulationFeatureKey = 'simulation';

const initialState: SimulationState = {
  connected: false,
  controls: {
    rudder: 0,
    sailTrim: 0,
    jib: {
      deploy: 0,
      sheet: 0,
      side: 0,
    },
    main: {
      deploy: 0,
      sheet: 0,
      side: 0,
    },
    anchored: true,
  },
  boats: [],
  projectiles: [],
  buoys: [],
  islands: [],
  playerBoatId: null,
  windDirection: 0,
  windStrength: 0,
  lakeId: null,
  lakeName: null,
  lakeBoats: 0,
  lakeCapacity: 0,
  lakeTotal: 0,
};

export const simulationReducer = createReducer(
  initialState,
  on(SimulationActions.connected, (state) => ({ ...state, connected: true })),
  on(SimulationActions.disconnected, (state) => ({ ...state, connected: false, playerBoatId: null })),
  on(SimulationActions.snapshotReceived, (state, { snapshot }) => ({
    ...state,
    boats: snapshot.boats,
    projectiles: snapshot.projectiles ?? [],
    buoys: snapshot.buoys ?? [],
    islands: snapshot.islands ?? state.islands,
    playerBoatId: snapshot.yourBoatId ?? state.playerBoatId,
    windDirection: snapshot.windDirection,
    windStrength: snapshot.windStrength,
    lakeId: snapshot.lakeId ?? state.lakeId,
    lakeName: snapshot.lakeName ?? state.lakeName,
    lakeBoats: snapshot.lakeBoats ?? state.lakeBoats,
    lakeCapacity: snapshot.lakeCapacity ?? state.lakeCapacity,
    lakeTotal: snapshot.lakeTotal ?? state.lakeTotal,
  })),
  on(SimulationActions.controlsChanged, (state, { controls }) => ({
    ...state,
    controls,
  }))
);
