import { Routes } from '@angular/router';
import { AppComponent } from './app.component';
import { AboutComponent } from './features/about/about.component';

export const routes: Routes = [
  { path: 'about', component: AboutComponent },
  { path: '', component: AppComponent },
];
