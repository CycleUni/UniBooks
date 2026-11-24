import { ActivatedRoute } from '@angular/router';
import { map, Observable, of, switchMap } from 'rxjs';
import { SchoolStateService } from '../../core/services/school-state.service';

/**
 * The school a course page is about: the one in the URL (a shared link) when
 * there is one, otherwise the one chosen in the header. Emits with the page's
 * other query parameter, which both course pages read.
 *
 * A school in the URL is used at once. Only without one does the page wait for
 * the header's choice to settle, so a visitor with a link never sees the page
 * ask them to pick a school.
 */
export function courseScope(route: ActivatedRoute, schoolState: SchoolStateService): Observable<{ school: string; name: string }> {
  return route.queryParamMap.pipe(
    switchMap((params) => {
      const name = params.get('name') || '';
      const inUrl = params.get('school');
      return inUrl ? of({ school: inUrl, name }) : schoolState.resolvedSchool$.pipe(map((school) => ({ school, name })));
    }),
  );
}
