import axios from "axios";
import { info, error } from "../utils/logger";

export class WeatherService {
  private readonly baseUrl = "https://api.open-meteo.com/v1";
  private readonly geocodeUrl = "https://geocoding-api.open-meteo.com/v1/search";

  async getForecast(lat: number, lon: number, current?: string[], hourly?: string[], daily?: string[], timezone = "auto") {
    try {
      const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        timezone,
      });
      if (current && current.length) params.append("current", current.join(","));
      if (hourly && hourly.length) params.append("hourly", hourly.join(","));
      if (daily && daily.length) params.append("daily", daily.join(","));

      const response = await axios.get(`${this.baseUrl}/forecast?${params.toString()}`);
      return response.data;
    } catch (err: any) {
      error(`[weatherService] Forecast failed: ${err.message}`);
      throw new Error("Failed to fetch weather forecast.");
    }
  }

  async getHistorical(lat: number, lon: number, startDate: string, endDate: string, hourly?: string[], daily?: string[], timezone = "auto") {
    try {
      const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        start_date: startDate,
        end_date: endDate,
        timezone,
      });
      if (hourly && hourly.length) params.append("hourly", hourly.join(","));
      if (daily && daily.length) params.append("daily", daily.join(","));

      const response = await axios.get(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`);
      return response.data;
    } catch (err: any) {
      error(`[weatherService] Historical failed: ${err.message}`);
      throw new Error("Failed to fetch historical weather.");
    }
  }

  async getAirQuality(lat: number, lon: number, hourly?: string[], timezone = "auto") {
    try {
      const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        timezone,
      });
      if (hourly && hourly.length) params.append("hourly", hourly.join(","));

      const response = await axios.get(`https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`);
      return response.data;
    } catch (err: any) {
      error(`[weatherService] Air Quality failed: ${err.message}`);
      throw new Error("Failed to fetch air quality data.");
    }
  }

  async getMarine(lat: number, lon: number, hourly?: string[], timezone = "auto") {
    try {
      const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        timezone,
      });
      if (hourly && hourly.length) params.append("hourly", hourly.join(","));

      const response = await axios.get(`https://marine-api.open-meteo.com/v1/marine?${params.toString()}`);
      return response.data;
    } catch (err: any) {
      error(`[weatherService] Marine failed: ${err.message}`);
      throw new Error("Failed to fetch marine data.");
    }
  }

  async geocode(name: string, count = 5) {
    try {
      const params = new URLSearchParams({
        name,
        count: count.toString(),
        language: "en",
        format: "json",
      });
      const response = await axios.get(`${this.geocodeUrl}?${params.toString()}`);
      return response.data;
    } catch (err: any) {
      error(`[weatherService] Geocode failed: ${err.message}`);
      throw new Error("Failed to geocode location.");
    }
  }
}
