import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import type { CourseDetailDto, CourseDto, CourseWantDto } from '../../../../../server/src/api-types';

/** Courses at a school, and "I am taking this course" requests. */
@Injectable({ providedIn: 'root' })
export class CourseService {
  private http = inject(HttpClient);

  private kept: { school: string; q: string; rows: CourseDto[] } | null = null;

  list(school: string, q = ''): Observable<CourseDto[]> {
    const query = q.trim();
    let params = new HttpParams().set('school', school);
    if (query) params = params.set('q', query);
    return this.http.get<CourseDto[]>('/courses', { params }).pipe(tap((rows) => (this.kept = { school, q: query, rows })));
  }

  /** The last list fetched, if it is the one asked for: what the visitor just left, to show again at once. */
  lastList(school: string, q = ''): CourseDto[] | null {
    return this.kept && this.kept.school === school && this.kept.q === q.trim() ? this.kept.rows : null;
  }

  detail(school: string, name: string): Observable<CourseDetailDto> {
    return this.http.get<CourseDetailDto>('/courses/detail', { params: new HttpParams().set('school', school).set('name', name) });
  }

  myWants(): Observable<CourseWantDto[]> {
    return this.http.get<CourseWantDto[]>('/courses/wants');
  }

  want(school: string, name: string): Observable<CourseWantDto> {
    return this.http.post<CourseWantDto>('/courses/wants', { school, name });
  }

  unwant(id: string): Observable<void> {
    return this.http.delete<void>(`/courses/wants/${id}`);
  }
}
