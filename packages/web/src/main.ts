/*
 * The web UI's entry point: starts the App component with app.config.ts and
 * logs a failed start to the console.
 */

import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
