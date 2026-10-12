import { Injectable, inject } from "@angular/core";
import { RegionService } from "./region.service";
export { stripRegionPrefix } from './region-path';


@Injectable({ providedIn: "root" })
export class RegionLinkService {
  private regionService = inject(RegionService);

  path(commands: any[] | string): any[] {
    const region = this.regionService.region();
    let pathArr = Array.isArray(commands) ? commands : [commands];
    
    if (pathArr[0] && typeof pathArr[0] === "string" && pathArr[0].startsWith("/")) {
      const parts = pathArr[0].substring(1).split("/").filter(Boolean);
      return ["/", region, ...parts, ...pathArr.slice(1)];
    }
    return pathArr as any[];
  }
}
