import { Component } from '@angular/core';
import { AuthFormComponent } from './auth-form.component';

/** /login — its own URL so the sign-in page can be linked to, shared and
 *  navigated back to. The form itself lives in AuthFormComponent, shared
 *  with /register. */
@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [AuthFormComponent],
  template: `<app-auth-form mode="login"></app-auth-form>`
})
export class LoginPage {}
