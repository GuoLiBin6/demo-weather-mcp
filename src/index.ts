/**
 * Weather MCP 服务入口
 * 通过标准输入/输出（stdio）与 MCP 客户端通信，向美国 NWS（National Weather Service）API 拉取天气预警与预报。
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/** NWS 公开 API 根地址 */
const NWS_API_BASE = "https://api.weather.gov";
/** 请求头中的 User-Agent，NWS 要求客户端标识 */
const USER_AGENT = "weather-app/1.0";

/**
 * 封装对 NWS API 的 GET 请求
 * @returns 解析后的 JSON，失败时打日志并返回 null
 */
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

/** GeoJSON 中单条预警要素的结构（仅用到 properties 字段） */
interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

/** 将一条预警格式化为多行可读文本 */
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

/** 预报时段（温度、风、简短描述等） */
interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

/** NWS alerts 接口返回的 GeoJSON 集合 */
interface AlertsResponse {
  features: AlertFeature[];
}

/** /points/{lat},{lon} 返回：内含后续预报资源的 URL */
interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

/** 预报详情接口返回 */
interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}

/**
 * 创建 MCP Server 实例并注册工具。
 * serveStdio 每次需要实例时会调用此工厂，因此须每次返回新实例。
 */
function createServer() {
  const server = new McpServer({
    name: "weather",
    version: "1.0.0",
  });

  // 工具：按美国州代码查询当前活跃天气预警
  server.registerTool(
    "get_alerts",
    {
      description: "Get weather alerts for a state",
      inputSchema: z.object({
        state: z
          .string()
          .length(2)
          .describe("Two-letter state code (e.g. CA, NY)"),
      }),
    },
    async ({ state }) => {
      const stateCode = state.toUpperCase();
      const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
      const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

      if (!alertsData) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to retrieve alerts data",
            },
          ],
        };
      }

      const features = alertsData.features || [];
      if (!features.length) {
        return {
          content: [
            {
              type: "text",
              text: `No active alerts for ${stateCode}`,
            },
          ],
        };
      }

      const formattedAlerts = features.map(formatAlert);
      const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;

      return {
        content: [
          {
            type: "text",
            text: alertsText,
          },
        ],
      };
    },
  );

  // 工具：按经纬度查询 NWS 预报（仅支持美国境内格点）
  server.registerTool(
    "get_forecast",
    {
      description: "Get weather forecast for a location",
      inputSchema: z.object({
        latitude: z
          .number()
          .min(-90)
          .max(90)
          .describe("Latitude of the location"),
        longitude: z
          .number()
          .min(-180)
          .max(180)
          .describe("Longitude of the location"),
      }),
    },
    async ({ latitude, longitude }) => {
      // 第一步：用坐标换取 NWS 网格点及预报 URL
      const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

      if (!pointsData) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
            },
          ],
        };
      }

      const forecastUrl = pointsData.properties?.forecast;
      if (!forecastUrl) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to get forecast URL from grid point data",
            },
          ],
        };
      }

      // 第二步：请求预报 JSON
      const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
      if (!forecastData) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to retrieve forecast data",
            },
          ],
        };
      }

      const periods = forecastData.properties?.periods || [];
      if (periods.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No forecast periods available",
            },
          ],
        };
      }

      // 将各时段格式化为文本块
      const formattedForecast = periods.map((period: ForecastPeriod) =>
        [
          `${period.name || "Unknown"}:`,
          `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
          `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
          `${period.shortForecast || "No forecast available"}`,
          "---",
        ].join("\n"),
      );

      const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;

      return {
        content: [
          {
            type: "text",
            text: forecastText,
          },
        ],
      };
    },
  );

  return server;
}

// 在 stdio 上启动 MCP 服务；错误写入 stderr
serveStdio(createServer, {
  onerror: (error) => console.error("Weather MCP Server error:", error),
});
console.error("Weather MCP Server running on stdio");
