import { createFeatureSelector, createSelector } from '@ngrx/store';
import { SimulationState } from './simulation.models';
import { simulationFeatureKey } from './simulation.reducer';

const selectSimulationState = createFeatureSelector<SimulationState>(simulationFeatureKey);

export const selectConnected = createSelector(selectSimulationState, (state) => state.connected);
export const selectBoats = createSelector(selectSimulationState, (state) => state.boats);
export const selectProjectiles = createSelector(selectSimulationState, (state) => state.projectiles);
export const selectBuoys = createSelector(selectSimulationState, (state) => state.buoys);
export const selectIslands = createSelector(selectSimulationState, (state) => state.islands);
export const selectPlayerBoatId = createSelector(selectSimulationState, (state) => state.playerBoatId);
export const selectWind = createSelector(selectSimulationState, (state) => ({
  direction: state.windDirection,
  strength: state.windStrength,
}));
export const selectControls = createSelector(selectSimulationState, (state) => state.controls);
export const selectLakes = createSelector(selectSimulationState, (state) => state.lakes);
export const selectWorld = createSelector(selectSimulationState, (state) => ({
  width: state.worldWidth,
  height: state.worldHeight,
}));
export const selectLake = createSelector(selectSimulationState, (state) => ({
  id: state.lakeId,
  name: state.lakeName,
  boats: state.lakeBoats,
  capacity: state.lakeCapacity,
  total: state.lakeTotal,
  size: state.lakes.find((lake) => lake.id === state.lakeId)?.size ?? 'SMALL',
}));