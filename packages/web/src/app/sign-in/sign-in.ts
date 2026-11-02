/*
 * The sign-in form: hands the pasted token and the "Stay signed in" choice to
 * Auth, and clears the box on success.
 */

import { Component, inject, signal } from '@angular/core';
import { Auth } from '../auth';

@Component({
  selector: 'app-sign-in',
  templateUrl: './sign-in.html',
})
export class SignIn {
  protected readonly auth = inject(Auth);
  protected readonly token = signal('');
  protected readonly remember = signal(false);

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (await this.auth.signIn(this.token(), this.remember()))
      this.token.set('');
  }
}
