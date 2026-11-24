import { Subject, BehaviorSubject } from 'rxjs';
import { convertToParamMap, ActivatedRoute, ParamMap } from '@angular/router';
import { courseScope } from './course-school';
import type { SchoolStateService } from '../../core/services/school-state.service';

describe('courseScope', () => {
  function setup(selected: string | null) {
    const params = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    // null: the header's choice has not settled, so resolvedSchool$ has not emitted.
    const resolved = new Subject<string>();
    const state = { resolvedSchool$: resolved.asObservable() } as unknown as SchoolStateService;
    const seen: Array<{ school: string; name: string }> = [];
    courseScope({ queryParamMap: params.asObservable() } as unknown as ActivatedRoute, state).subscribe((v) => seen.push(v));
    if (selected !== null) resolved.next(selected);
    return { params, resolved, seen };
  }

  it('uses the school in the URL at once, without waiting for the header', () => {
    const { params, seen } = setup(null);
    params.next(convertToParamMap({ school: 'NTU', name: 'Calculus' }));
    expect(seen).toEqual([{ school: 'NTU', name: 'Calculus' }]);
  });

  it('prefers the URL\'s school to the header\'s', () => {
    const { params, seen } = setup('NCKU');
    params.next(convertToParamMap({ school: 'NTU' }));
    expect(seen[seen.length - 1]).toEqual({ school: 'NTU', name: '' });
  });

  it('waits for the header\'s choice when the URL names no school', () => {
    const { seen, resolved } = setup(null);
    expect(seen).toEqual([]);
    resolved.next('NCKU');
    expect(seen).toEqual([{ school: 'NCKU', name: '' }]);
  });

  it('follows the header when the visitor picks another school', () => {
    const { seen, resolved } = setup('NTU');
    resolved.next('NCKU');
    expect(seen.map((v) => v.school)).toEqual(['NTU', 'NCKU']);
  });
});
