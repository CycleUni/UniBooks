import { Component, inject } from '@angular/core';
import { MeetupDetailsService } from '../../core/services/meetup-details.service';
import { MeetupModalComponent } from './meetup-modal.component';

/**
 * Renders the meetup time/place form for MeetupDetailsService. Placed once in
 * the app shell, beside the confirm dialog, so any page can ask for it.
 *
 * The form (a whole calendar) is deferred: mounted in the shell it would
 * otherwise sit in the initial bundle for every visitor, when only a seller
 * accepting a meetup ever opens it. It loads on the first accept.
 */
@Component({
  selector: 'ui-meetup-details-host',
  standalone: true,
  imports: [MeetupModalComponent],
  template: `
    @if (meetupDetails.current(); as request) {
      @defer (on immediate) {
        <app-meetup-modal
          [bookTitle]="request.bookTitle"
          [initial]="request.initial"
          (onConfirmed)="meetupDetails.settle(request.id, $event)"
          (onClosed)="meetupDetails.settle(request.id, null)"
        ></app-meetup-modal>
      }
    }
  `,
})
export class UiMeetupDetailsHost {
  readonly meetupDetails = inject(MeetupDetailsService);
}
