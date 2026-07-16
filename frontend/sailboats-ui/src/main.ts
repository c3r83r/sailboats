import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';
import { AppShellComponent } from './app/app-shell.component';
import { routes } from './app/app.routes';
import { simulationFeatureKey, simulationReducer } from './app/store/simulation/simulation.reducer';
import { SimulationEffects } from './app/store/simulation/simulation.effects';

bootstrapApplication(AppShellComponent, {
  providers: [
    provideHttpClient(),
    provideRouter(routes),
    provideStore({
      [simulationFeatureKey]: simulationReducer,
    }),
    provideEffects([SimulationEffects]),
  ],
}).catch((err) => console.error(err));
