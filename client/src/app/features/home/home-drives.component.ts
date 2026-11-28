import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import {
  DriveService,
  type DriveTitle,
  type OpenDrive,
} from '../../core/services/drive.service';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiDrivePin, claimDeadline } from '../../shared/ui/drive-pin.component';

/**
 * How many titles to ask for: enough to fill one row of the widest grid
 * (the server's MAX_PREVIEW_TITLES). The page shows one row of them.
 */
const PREVIEW_TITLES = 12;

/** The columns an auto-fill grid has laid out at its current width. */
function gridColumns(grid: Element | null): number {
  if (!grid) return 0;
  return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
}

/**
 * The home page's notice for the school chosen in the header: each of its
 * student organizations giving books away now (收書贈書 taking registrations),
 * with a line on until when and how many, and some of the books as tiles to
 * register for right there: one row of them, as many as the grid fits at the
 * current width; "view all" opens the drive's page with the rest. Nothing at
 * all when no school is chosen or none of its organizations runs one.
 */
@Component({
  selector: 'app-home-drives',
  standalone: true,
  imports: [CommonModule, TPipe, UiBookTile, UiButton, UiDrivePin],
  template: `
    <section
      class="section container home-drive"
      *ngFor="let d of drives; trackBy: trackDrive"
      [attr.aria-labelledby]="'home-drive-' + d.id"
    >
      <div class="section-head-row">
        <h2 class="section-heading" [id]="'home-drive-' + d.id">
          {{ 'home.driveTitle' | t: { org: d.organization.display_name } }}
        </h2>
        <ui-button variant="ghost" [link]="['/drive']" [linkParams]="{ id: d.id }">{{
          'home.driveViewAll' | t: { n: d.titles }
        }}</ui-button>
      </div>
      <p class="drive-lead">
        {{
          'home.driveLead'
            | t
              : {
                  time: deadline(d),
                  titles: d.titles,
                  copies: d.copies,
                  max: d.max_claims_per_user,
                }
        }}
      </p>
      <div class="discover-grid">
        <ui-book-tile
          *ngFor="let t of (d.preview ?? []).slice(0, columns); trackBy: trackTitle"
          mode="plain"
          [title]="t.book.title"
          [author]="t.book.authors"
          [isbn]="t.book.isbn13 || ''"
          [coverUrl]="t.book.cover_url"
          [link]="['/book']"
          [linkParams]="{ id: t.book.id }"
        >
          <ui-drive-pin
            tile-actions
            [compact]="true"
            [drive]="d"
            [bookId]="t.book.id"
            [bookTitle]="t.book.title"
            [remaining]="t.remaining"
            [claimants]="t.claimants"
            [claim]="t.my_claim"
            (claimChange)="t.my_claim = $event"
          ></ui-drive-pin>
        </ui-book-tile>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      /* home.ts's .section rhythm: its styles do not reach into this component. */
      .home-drive {
        margin-bottom: var(--space-7);
      }
      .drive-lead {
        margin: calc(-1 * var(--space-3)) 0 var(--space-5);
        color: var(--muted);
        font-size: var(--text-base);
        line-height: 1.6;
      }
    `,
  ],
})
export class HomeDrives implements OnChanges, AfterViewInit, OnDestroy {
  private driveService = inject(DriveService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private resize?: ResizeObserver;

  /** The school chosen in the header ('' for all schools: no notice). */
  @Input() school = '';

  drives: OpenDrive[] = [];
  /** Tiles in one row of the grid; 0 until the grid is first measured. */
  columns = 0;
  private asked = '';

  trackDrive = (_: number, d: OpenDrive) => d.id;
  trackTitle = (_: number, t: DriveTitle) => t.book.id;
  deadline = (d: OpenDrive) => claimDeadline(d.claim_closes_at, this.i18n.lang());

  ngOnChanges(): void {
    this.load();
  }

  // The host grows when a section appears and with the window: either way the
  // grid's column count may change, and one row is that many tiles.
  ngAfterViewInit(): void {
    if (typeof ResizeObserver === 'undefined') {
      this.columns = PREVIEW_TITLES;
      return;
    }
    this.resize = new ResizeObserver(() => {
      const columns = gridColumns(this.host.nativeElement.querySelector('.discover-grid'));
      if (columns && columns !== this.columns) {
        this.columns = columns;
        this.cdr.markForCheck();
      }
    });
    this.resize.observe(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.resize?.disconnect();
  }

  /** Asked again on pull to refresh. */
  load(): void {
    const school = this.school;
    this.asked = school;
    if (!school) {
      this.drives = [];
      this.cdr.markForCheck();
      return;
    }
    this.driveService.openAtSchool(school, PREVIEW_TITLES).subscribe({
      next: (res) => {
        // A late answer for a school the header has since moved off.
        if (this.asked !== school) return;
        this.drives = res.results.filter((d) => d.open && d.preview?.length);
        this.cdr.markForCheck();
      },
      // A notice, not the page's content: on failure the home page simply goes without it.
      error: () => {
        this.drives = [];
        this.cdr.markForCheck();
      },
    });
  }
}
