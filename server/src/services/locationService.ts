import axios from "axios";
import { info, error } from "../utils/logger";

export interface LocationData {
  status: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
  query?: string;
}

export class LocationService {
  private cachedLocation: LocationData | null = null;
  private lastFetched: number = 0;
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  async getCurrentLocation(forceRefresh = false): Promise<LocationData | null> {
    const now = Date.now();
    
    if (!forceRefresh && this.cachedLocation && (now - this.lastFetched < this.CACHE_TTL_MS)) {
      return this.cachedLocation;
    }

    try {
      // 61439 is the bitmask for all fields requested in the plan
      const response = await axios.get<LocationData>("http://ip-api.com/json/?fields=61439", { timeout: 5000 });
      if (response.data && response.data.status === "success") {
        this.cachedLocation = response.data;
        this.lastFetched = now;
        info(`[locationService] Fetched live location: ${response.data.city}, ${response.data.country}`);
        return this.cachedLocation;
      }
      return null;
    } catch (err: any) {
      error(`[locationService] Failed to fetch live location: ${err.message}`);
      return this.cachedLocation; // fallback to stale cache if offline
    }
  }

  formatLocationContext(loc: LocationData | null): string {
    if (!loc) return "Current User Location: Unknown";
    
    const parts = [];
    if (loc.city && loc.country) parts.push(`${loc.city}, ${loc.country}`);
    else if (loc.country) parts.push(loc.country);

    if (loc.lat && loc.lon) parts.push(`(Lat: ${loc.lat}, Lon: ${loc.lon})`);
    if (loc.timezone) parts.push(`Timezone: ${loc.timezone}`);
    if (loc.isp) parts.push(`ISP: ${loc.isp}`);
    if (loc.mobile) parts.push("[Mobile Network]");
    if (loc.proxy || loc.hosting) parts.push("[Proxy/VPN Detected]");

    return `Current User Location: ${parts.join(". ")}`;
  }
}
