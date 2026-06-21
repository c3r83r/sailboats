import { bootstrapApplication } from '@angular/platform-browser';
import { provideStore } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';
import { AppComponent } from './app/app.component';
import { simulationFeatureKey, simulationReducer } from './app/store/simulation/simulation.reducer';
import { SimulationEffects } from './app/store/simulation/simulation.effects';

bootstrapApplication(AppComponent, {
  providers: [
    provideStore({
      [simulationFeatureKey]: simulationReducer,
    }),
    provideEffects([SimulationEffects]),
  ],
}).catch((err) => console.error(err));
