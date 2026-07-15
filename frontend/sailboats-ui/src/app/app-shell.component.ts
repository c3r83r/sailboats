import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

// Thin bootstrap component: hosts the router so both the game (AppComponent)
// and standalone pages (e.g. /about) can be routed to independently.
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class AppShellComponent {}
