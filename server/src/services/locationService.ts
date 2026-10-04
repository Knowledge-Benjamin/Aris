import axios from "axios";
import { info, error } from "../utils/logger";

export interface LocationData {
  status: string;
  source?: "android" | "ip";
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
  accuracyMeters?: number;
  capturedAtEpochMs?: number;
}

interface DeviceLocationInput {
  lat: number;
  lon: number;
  accuracyMeters?: number;
  capturedAtEpochMs: number;
  timezone?: string;
}

export class LocationService {
  private cachedLocation: LocationData | null = null;
  private lastFetched: number = 0;
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private readonly DEVICE_LOCATION_TTL_MS = 2 * 60 * 1000;
  private readonly deviceLocations = new Map<number, LocationData>();

  setDeviceLocation(userId: number, input: DeviceLocationInput): void {
    const now = Date.now();
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error("A valid authenticated user is required.");
    }
    if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90 ||
        !Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180) {
      throw new Error("Latitude or longitude is outside its valid range.");
    }
    if (!Number.isFinite(input.capturedAtEpochMs) ||
        input.capturedAtEpochMs > now + 30_000 ||
        now - input.capturedAtEpochMs > 5 * 60 * 1000) {
      throw new Error("Location timestamp is stale or invalid.");
    }
    if (input.accuracyMeters !== undefined &&
        (!Number.isFinite(input.accuracyMeters) || input.accuracyMeters <= 0 || input.accuracyMeters > 50_000)) {
      throw new Error("Location accuracy must be between 0 and 50000 meters.");
    }

    let timezone: string | undefined;
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== "string" || input.timezone.length > 64) {
        throw new Error("Timezone is invalid.");
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
        timezone = input.timezone;
      } catch {
        throw new Error("Timezone is invalid.");
      }
    }

    this.deviceLocations.set(userId, {
      status: "success",
      source: "android",
      lat: input.lat,
      lon: input.lon,
      accuracyMeters: input.accuracyMeters,
      capturedAtEpochMs: input.capturedAtEpochMs,
      timezone,
    });
  }

  async getCurrentLocation(forceRefresh = false, userId?: number): Promise<LocationData | null> {
    const now = Date.now();

    if (userId !== undefined) {
      const deviceLocation = this.deviceLocations.get(userId);
      if (deviceLocation?.capturedAtEpochMs !== undefined &&
          now - deviceLocation.capturedAtEpochMs <= this.DEVICE_LOCATION_TTL_MS) {
        return deviceLocation;
      }
      if (deviceLocation) this.deviceLocations.delete(userId);
    }

    if (!forceRefresh && this.cachedLocation && (now - this.lastFetched < this.CACHE_TTL_MS)) {
      return this.cachedLocation;
    }

    try {
      // 61439 is the bitmask for all fields requested in the plan
      const response = await axios.get<LocationData>("http://ip-api.com/json/?fields=61439", { timeout: 5000 });
      if (response.data && response.data.status === "success") {
        this.cachedLocation = { ...response.data, source: "ip" };
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

    if (loc.lat !== undefined && loc.lon !== undefined) {
      parts.push(`(Lat: ${loc.lat}, Lon: ${loc.lon})`);
    }
    if (loc.source === "android") {
      parts.push("Source: current location shared by the Android app");
      if (loc.accuracyMeters !== undefined) parts.push(`Reported accuracy: about ${Math.round(loc.accuracyMeters)} m`);
    } else {
      parts.push("Source: approximate network geolocation");
    }
    if (loc.timezone) parts.push(`Timezone: ${loc.timezone}`);
    if (loc.isp) parts.push(`ISP: ${loc.isp}`);
    if (loc.mobile) parts.push("[Mobile Network]");
    if (loc.proxy || loc.hosting) parts.push("[Proxy/VPN Detected]");

    return `Current User Location: ${parts.join(". ")}`;
  }
}
