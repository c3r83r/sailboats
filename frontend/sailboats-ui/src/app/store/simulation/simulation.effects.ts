import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { map, merge, mergeMap, tap } from 'rxjs';
import { SimulationWsService } from '../../core/services/simulation-ws.service';
import { SimulationActions } from './simulation.actions';

@Injectable()
export class SimulationEffects {
  connect$ = createEffect(() =>
    this.actions$.pipe(
      ofType(SimulationActions.connect),
      mergeMap(() =>
        merge(
          this.simulationWsService.connect().pipe(
            map((snapshot) => SimulationActions.snapshotReceived({ snapshot }))
          ),
          this.simulationWsService.status$().pipe(
            map((status) =>
              status === 'connected' ? SimulationActions.connected() : SimulationActions.disconnected()
            )
          )
        )
      )
    )
  );

  controlsChanged$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(SimulationActions.controlsChanged),
        tap(({ controls }) => this.simulationWsService.sendControls(controls.rudder, controls.sailTrim, controls.anchored))
      ),
    { dispatch: false }
  );

  fire$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(SimulationActions.fire),
        tap(({ side, power }) => this.simulationWsService.sendFire(side, power))
      ),
    { dispatch: false }
  );

  constructor(private actions$: Actions, private simulationWsService: SimulationWsService) {}
}
