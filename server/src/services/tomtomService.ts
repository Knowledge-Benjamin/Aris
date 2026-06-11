import dotenv from "dotenv";
import axios from "axios";
import { info, error } from "../utils/logger";

dotenv.config();

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY?.trim() ?? "";
if (!TOMTOM_API_KEY) {
  throw new Error("TOMTOM_API_KEY is required in environment configuration.");
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface TomTomLocation {
  lat: number;
  lon: number;
  displayName: string;
  address: string;
}

export interface TomTomTrafficRouteSummary {
  origin: TomTomLocation;
  destination: TomTomLocation;
  travelTimeInSeconds: number;
  travelTimeWithoutTrafficInSeconds: number;
  travelTimeWithTrafficInSeconds: number;
  lengthInMeters: number;
  trafficDelayInSeconds: number;
  trafficDelayMinutes: number;
  routeType: string;
  travelMode: string;
  departureTime?: string;
  arrivalTime?: string;
  raw: any;
}

export interface TomTomTrafficFlowSummary {
  location: TomTomLocation;
  currentSpeed?: number;
  freeFlowSpeed?: number;
  confidence?: number;
  status?: string;
  raw: any;
}

export interface TomTomTrafficIncidentEvent {
  description?: string;
  code?: number;
  iconCategory?: number;
}

export interface TomTomTrafficIncident {
  id?: string;
  iconCategory?: number;
  category?: string;
  magnitudeOfDelay?: number;
  events?: TomTomTrafficIncidentEvent[];
  startTime?: string;
  endTime?: string;
  from?: string;
  to?: string;
  length?: number;
  delay?: number;
  roadNumbers?: string[];
  timeValidity?: string;
  probabilityOfOccurrence?: string;
  numberOfReports?: number;
  lastReportTime?: string;
  geometry?: any;
  raw: any;
}

export interface TomTomTrafficIncidentSummary {
  location: TomTomLocation;
  bbox: string;
  incidentCount: number;
  incidents: TomTomTrafficIncident[];
  raw: any;
}

export class TomTomService {
  private readonly apiKey = TOMTOM_API_KEY;
  private readonly baseUrl = "https://api.tomtom.com";

  private async requestWithRetry<T>(url: string, params: Record<string, any>, timeout = 30000): Promise<import("axios").AxiosResponse<T>> {
    const maxAttempts = 3;
    let attempt = 0;
    let lastError: any;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await axios.get<T>(url, {
          params,
          timeout,
        });
      } catch (err: any) {
        lastError = err;
        const recoverable = ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED"].includes(err?.code);
        const serverError = err?.response?.status >= 500;
        if (attempt >= maxAttempts || (!recoverable && !serverError)) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  public async geocode(query: string): Promise<TomTomLocation> {
    const url = `${this.baseUrl}/search/2/geocode/${encodeURIComponent(query)}.json`;
    info(`[tomtomService] geocode ${query}`);

    try {
      const response = await axios.get(url, {
        params: {
          key: this.apiKey,
          limit: 1,
        },
        timeout: 30000,
      });

      const result = response.data?.results?.[0];
      if (!result || !result.position) {
        throw new Error(`Unable to geocode location: ${query}`);
      }

      return {
        lat: result.position.lat,
        lon: result.position.lon,
        displayName: result.address?.freeformAddress || query,
        address: result.address?.freeformAddress || query,
      };
    } catch (err: any) {
      error("[tomtomService] geocode failed", { query, message: err?.message, response: err?.response?.data });
      throw new Error(`TomTom geocode failed for ${query}: ${err?.message || "unknown error"}`);
    }
  }

  public async getTrafficRoute(
    origin: string | LatLon,
    destination: string | LatLon,
    options?: {
      mode?: string;
      departureTime?: string;
    }
  ): Promise<TomTomTrafficRouteSummary> {
    const originPoint = await this.resolveLocation(origin);
    const destinationPoint = await this.resolveLocation(destination);
    const travelMode = options?.mode?.toLowerCase() === "truck" ? "truck" : "car";
    const routeType = "fastest";
    const path = `${originPoint.lat},${originPoint.lon}:${destinationPoint.lat},${destinationPoint.lon}`;
    const url = `${this.baseUrl}/routing/1/calculateRoute/${encodeURIComponent(path)}/json`;
    const params: Record<string, string | boolean> = {
      key: this.apiKey,
      traffic: true,
      routeType,
      travelMode,
      instructionsType: "text",
      computeBestOrder: false,
      sectionType: "none",
      avoid: "unpavedRoads",
      mapMatching: "none",
    };

    if (options?.departureTime) {
      params.departureTime = options.departureTime;
    } else {
      params.departureTime = "now";
    }

    info(`[tomtomService] getTrafficRoute origin=${originPoint.displayName} destination=${destinationPoint.displayName} mode=${travelMode}`);

    try {
      const response = await axios.get(url, {
        params,
        timeout: 30000,
      });

      const route = response.data?.routes?.[0];
      if (!route || !route.summary) {
        throw new Error("No route data returned from TomTom.");
      }

      const summary = route.summary;
      const travelTimeWithTrafficInSeconds = summary.travelTimeInSeconds ?? 0;
      const travelTimeWithoutTrafficInSeconds = summary.travelTimeInSeconds - (summary.trafficDelayInSeconds ?? 0);
      const trafficDelayInSeconds = summary.trafficDelayInSeconds ?? 0;

      return {
        origin: originPoint,
        destination: destinationPoint,
        travelTimeInSeconds: travelTimeWithTrafficInSeconds,
        travelTimeWithoutTrafficInSeconds,
        travelTimeWithTrafficInSeconds,
        lengthInMeters: summary.lengthInMeters ?? 0,
        trafficDelayInSeconds,
        trafficDelayMinutes: Math.round((trafficDelayInSeconds / 60) * 10) / 10,
        routeType: summary.routeType || routeType,
        travelMode,
        departureTime: summary.departureTime,
        arrivalTime: summary.arrivalTime,
        raw: route,
      };
    } catch (err: any) {
      error("[tomtomService] getTrafficRoute failed", {
        origin: originPoint,
        destination: destinationPoint,
        message: err?.message,
        response: err?.response?.data,
      });
      throw new Error(`TomTom route request failed: ${err?.message || "unknown error"}`);
    }
  }

  public async getTrafficFlow(location: string | LatLon): Promise<TomTomTrafficFlowSummary> {
    const point = await this.resolveLocation(location);
    const url = `${this.baseUrl}/traffic/services/4/flowSegmentData/absolute/10/json`;
    info(`[tomtomService] getTrafficFlow location=${point.displayName}`);

    try {
      const response = await this.requestWithRetry<any>(url, {
        key: this.apiKey,
        point: `${point.lat},${point.lon}`,
        unit: "KMPH",
        openLr: false,
      });

      const flow = response.data?.flowSegmentData;
      if (!flow) {
        throw new Error("No flow data returned from TomTom.");
      }

      return {
        location: point,
        currentSpeed: flow.currentSpeed,
        freeFlowSpeed: flow.freeFlowSpeed,
        confidence: flow.confidence,
        status: flow.currentSpeed && flow.freeFlowSpeed
          ? flow.currentSpeed < flow.freeFlowSpeed * 0.85
            ? "Heavy traffic"
            : "Normal traffic"
          : "Unknown",
        raw: flow,
      };
    } catch (err: any) {
      error("[tomtomService] getTrafficFlow failed", {
        location: point,
        message: err?.message,
        response: err?.response?.data,
      });
      throw new Error(`TomTom flow request failed: ${err?.message || "unknown error"}`);
    }
  }

  public async getTrafficIncidents(
    location: string | LatLon | { bbox: string; label?: string },
    options?: {
      categoryFilter?: string;
      timeValidityFilter?: string;
      language?: string;
      fields?: string;
    }
  ): Promise<TomTomTrafficIncidentSummary> {
    const locationInfo = await this.resolveIncidentBoundingBox(location);
    const url = `${this.baseUrl}/traffic/services/5/incidentDetails`;
    info(`[tomtomService] getTrafficIncidents location=${locationInfo.location.displayName} bbox=${locationInfo.bbox}`);

    const fields = options?.fields ??
      "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}";

    try {
      const response = await this.requestWithRetry<any>(url, {
        key: this.apiKey,
        bbox: locationInfo.bbox,
        fields,
        language: options?.language || "en-GB",
        timeValidityFilter: options?.timeValidityFilter || "present",
        categoryFilter: options?.categoryFilter,
      });

      const incidents = response.data?.incidents || [];
      const mappedIncidents = Array.isArray(incidents)
        ? incidents.map((item: any) => ({
            id: item?.properties?.id,
            iconCategory: item?.properties?.iconCategory,
            category: item?.properties?.iconCategory,
            magnitudeOfDelay: item?.properties?.magnitudeOfDelay,
            events: Array.isArray(item?.properties?.events) ? item.properties.events.map((event: any) => ({
              description: event.description,
              code: event.code,
              iconCategory: event.iconCategory,
            })) : undefined,
            startTime: item?.properties?.startTime,
            endTime: item?.properties?.endTime,
            from: item?.properties?.from,
            to: item?.properties?.to,
            length: item?.properties?.length,
            delay: item?.properties?.delay,
            roadNumbers: item?.properties?.roadNumbers,
            timeValidity: item?.properties?.timeValidity,
            probabilityOfOccurrence: item?.properties?.probabilityOfOccurrence,
            numberOfReports: item?.properties?.numberOfReports,
            lastReportTime: item?.properties?.lastReportTime,
            geometry: item?.geometry,
            raw: item,
          }))
        : [];

      return {
        location: locationInfo.location,
        bbox: locationInfo.bbox,
        incidentCount: mappedIncidents.length,
        incidents: mappedIncidents,
        raw: response.data,
      };
    } catch (err: any) {
      error("[tomtomService] getTrafficIncidents failed", {
        location: locationInfo.location,
        bbox: locationInfo.bbox,
        message: err?.message,
        response: err?.response?.data,
      });
      throw new Error(`TomTom incidents request failed: ${err?.message || "unknown error"}`);
    }
  }

  private async resolveIncidentBoundingBox(location: string | LatLon | { bbox: string; label?: string }) {
    if (typeof location !== "string" && !Array.isArray(location) && "bbox" in location) {
      const [minLon, minLat, maxLon, maxLat] = location.bbox.split(",")
        .map((value) => Number(value.trim()));
      const centerLat = (minLat + maxLat) / 2;
      const centerLon = (minLon + maxLon) / 2;
      return {
        bbox: location.bbox,
        location: {
          lat: centerLat,
          lon: centerLon,
          displayName: location.label || `${centerLat},${centerLon}`,
          address: location.label || `${centerLat},${centerLon}`,
        },
      };
    }

    const point = await this.resolveLocation(location as string | LatLon);
    const delta = 0.035;
    const minLat = Math.max(point.lat - delta, -90);
    const maxLat = Math.min(point.lat + delta, 90);
    const minLon = Math.max(point.lon - delta, -180);
    const maxLon = Math.min(point.lon + delta, 180);

    return {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      location: point,
    };
  }

  public async getTrafficFromQuery(query: string, options?: { mode?: string; departureTime?: string }): Promise<TomTomTrafficRouteSummary | TomTomTrafficFlowSummary | TomTomTrafficIncidentSummary> {
    const routeMatch = query.match(/from\s+(.+?)\s+(?:to|towards?)\s+(.+)/i) || query.match(/to\s+(.+?)\s+from\s+(.+)/i);
    if (routeMatch) {
      const origin = routeMatch[1].trim();
      const destination = routeMatch[2].trim();
      return this.getTrafficRoute(origin, destination, options);
    }

    const incidentKeywords = /\b(incident|incidents|accident|accidents|roadworks|road work|closure|closed road|construction|crash|collision|hazard|breakdown|delays?)\b/i;
    if (incidentKeywords.test(query)) {
      return this.getTrafficIncidents(query);
    }

    const locationMatch = query.match(/(?:traffic\s+(?:in|near|around)|near|around|at)\s+(.+)/i);
    if (locationMatch) {
      return this.getTrafficFlow(locationMatch[1].trim());
    }

    return this.getTrafficFlow(query);
  }

  private async resolveLocation(location: string | LatLon): Promise<TomTomLocation> {
    if (typeof location !== "string") {
      return {
        lat: location.lat,
        lon: location.lon,
        displayName: `${location.lat},${location.lon}`,
        address: `${location.lat},${location.lon}`,
      };
    }

    const pairMatch = location.trim().match(/^([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)$/);
    if (pairMatch) {
      return {
        lat: Number(pairMatch[1]),
        lon: Number(pairMatch[2]),
        displayName: location.trim(),
        address: location.trim(),
      };
    }

    return this.geocode(location);
  }
}
