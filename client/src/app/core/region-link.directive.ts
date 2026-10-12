import { Directive, Input, effect, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { RegionService } from "./region.service";

/** `[regionLink]="['/account', 'listings']"` — a RouterLink always prefixed
 * with the active region.
 *
 * The value is pushed to the host RouterLink from an effect rather than from
 * the `@Input` setter alone: computing it once at bind time left links holding
 * whatever region was current when they were created, so after the region
 * guard corrected the URL, clicking one navigated into the *other* region.
 * RouterLink's own `routerLink` setter writes into a signal, so assigning from
 * an effect updates the rendered href.
 *
 * Any component whose template uses this must list RegionLinkDirective in its
 * `imports`. Without it the attribute is inert HTML — the anchor gets no href
 * and silently does nothing when clicked.
 */
@Directive({
  selector: "[regionLink]",
  standalone: true,
  hostDirectives: [{
    directive: RouterLink,
    inputs: ["target", "queryParams", "fragment", "queryParamsHandling", "state", "info", "relativeTo", "preserveFragment", "skipLocationChange", "replaceUrl"]
  }]
})
export class RegionLinkDirective {
  private routerLink = inject(RouterLink);
  private regionService = inject(RegionService);
  private commands: any[] | string | null | undefined;

  constructor() {
    effect(() => {
      // Read unconditionally so the effect stays subscribed to the region even
      // while `commands` has not been bound yet.
      const region = this.regionService.region();

      if (!this.commands) {
        this.routerLink.routerLink = this.commands as any;
        return;
      }

      const pathArr = Array.isArray(this.commands) ? this.commands : [this.commands];

      if (pathArr[0] && typeof pathArr[0] === "string" && pathArr[0].startsWith("/")) {
        const parts = pathArr[0].substring(1).split("/").filter(Boolean);
        this.routerLink.routerLink = ["/", region, ...parts, ...pathArr.slice(1)];
      } else {
        // Relative commands are left alone — they resolve against the
        // activated route, which already sits under the region segment.
        this.routerLink.routerLink = this.commands as any;
      }
    });
  }

  @Input() set regionLink(commands: any[] | string | null | undefined) {
    this.commands = commands;
  }
}
