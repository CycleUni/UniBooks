import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * Asks for the school picker to be shown: a page that cannot say anything until
 * the visitor has chosen a school (the course pages) calls open(), and the
 * welcome dialog, which already is that picker, answers. The choice is the same
 * one the header's school switcher makes.
 */
@Injectable({ providedIn: 'root' })
export class SchoolPickerService {
  private readonly requested = new Subject<void>();
  readonly requests$: Observable<void> = this.requested.asObservable();

  open(): void {
    this.requested.next();
  }
}
