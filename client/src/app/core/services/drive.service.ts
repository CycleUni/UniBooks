import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/**
 * Book drives (收書贈書): a student organization gives away the books it
 * collected, and students register for the titles they want (登記). The
 * rules live on the server (server/src/services/drives/claims.ts); this only
 * carries them.
 */

export type ClaimStatus =
  'registered' | 'won' | 'waitlisted' | 'not_won' | 'picked_up' | 'forfeited' | 'cancelled';

export interface DriveClaim {
  id: string;
  book_id: string;
  status: ClaimStatus;
  /** The student number staff approved at the organization's school ('' when none). */
  student_number: string;
  department: string;
  grade: number | null;
  created_at: string;
  updated_at: string;
}

/** What every public view of a drive carries. */
export interface DriveHead {
  id: string;
  region: string;
  title: string;
  description: string;
  /** 'claiming' while public; an account's registrations also show drives that moved on ('closed'). */
  status: string;
  organization: { id: string; display_name: string };
  claim_opens_at: string | null;
  claim_closes_at: string | null;
  max_claims_per_user: number;
  /** Taking registrations now. */
  open: boolean;
}

/** A drive as a book page pins it. */
export interface BookDrive extends DriveHead {
  remaining: number;
  claimants: number;
  my_claim: DriveClaim | null;
}

export interface DriveTitle {
  book: { id: string; title: string; authors: string; isbn13: string | null; cover_url: string };
  remaining: number;
  claimants: number;
  my_claim: DriveClaim | null;
}

export interface DrivePage extends DriveHead {
  my_claims: number;
  titles: DriveTitle[];
}

/** A drive taking registrations, as a list (the event system, a school's home page) shows it. */
export interface OpenDrive extends DriveHead {
  titles: number;
  copies: number;
  /** Some of its titles, most copies left first, when asked for. */
  preview?: DriveTitle[];
}

export interface MyClaim extends DriveClaim {
  book: { id: string; title: string; authors: string; cover_url: string };
  drive: DriveHead;
}

export interface ClaimDefaults {
  student_number: string;
  department: string;
  grade: number | null;
  from_roster: boolean;
}

export interface ClaimInput {
  department: string;
  grade: number | null;
}

@Injectable({ providedIn: 'root' })
export class DriveService {
  private http = inject(HttpClient);

  /** The drives a school's organizations run that take registrations, each previewing up to `titles` titles. */
  openAtSchool(school: string, titles: number): Observable<{ results: OpenDrive[] }> {
    return this.http.get<{ results: OpenDrive[] }>('/drives/open', { params: { school, titles: String(titles) } });
  }

  drive(id: string): Observable<DrivePage> {
    return this.http.get<DrivePage>(`/drives/${encodeURIComponent(id)}/public`);
  }

  defaults(driveId: string): Observable<ClaimDefaults> {
    return this.http.get<ClaimDefaults>(`/drives/${encodeURIComponent(driveId)}/claim-defaults`);
  }

  register(driveId: string, bookId: string, input: ClaimInput): Observable<DriveClaim> {
    return this.http.post<DriveClaim>(`/drives/${encodeURIComponent(driveId)}/claims`, {
      book_id: bookId,
      ...input,
    });
  }

  update(driveId: string, claimId: string, input: Partial<ClaimInput>): Observable<DriveClaim> {
    return this.http.patch<DriveClaim>(
      `/drives/${encodeURIComponent(driveId)}/claims/${encodeURIComponent(claimId)}`,
      input,
    );
  }

  cancel(driveId: string, claimId: string): Observable<DriveClaim> {
    return this.http.delete<DriveClaim>(
      `/drives/${encodeURIComponent(driveId)}/claims/${encodeURIComponent(claimId)}`,
    );
  }

  mine(): Observable<{ results: MyClaim[] }> {
    return this.http.get<{ results: MyClaim[] }>('/drives/claims/mine');
  }
}
