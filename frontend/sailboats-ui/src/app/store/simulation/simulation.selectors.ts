import { createFeatureSelector, createSelector } from '@ngrx/store';
import { SimulationState } from './simulation.models';
import { simulationFeatureKey } from './simulation.reducer';

const selectSimulationState = createFeatureSelector<SimulationState>(simulationFeatureKey);

export const selectConnected = createSelector(selectSimulationState, (state) => state.connected);
export const selectBoats = createSelector(selectSimulationState, (state) => state.boats);
export const selectProjectiles = createSelector(selectSimulationState, (state) => state.projectiles);
export const selectPlayerBoatId = createSelector(selectSimulationState, (state) => state.playerBoatId);
export const selectWind = createSelector(selectSimulationState, (state) => ({
  direction: state.windDirection,
  strength: state.windStrength,
}));
export const selectControls = createSelector(selectSimulationState, (state) => state.controls);
