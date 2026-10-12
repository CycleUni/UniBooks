import { Component } from '@angular/core';
import { AuthFormComponent } from './auth-form.component';

/** /register — the sign-up half of the old /account login wall, now with an
 *  address of its own that campaigns and onboarding links can point at. */
@Component({
  selector: 'app-register-page',
  standalone: true,
  imports: [AuthFormComponent],
  template: `<app-auth-form mode="register"></app-auth-form>`
})
export class RegisterPage {}
