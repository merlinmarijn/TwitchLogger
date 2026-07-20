interface RuntimeConfig {
  workerUrl?: string;
  configurationIssues?: string[];
}

declare global {
  interface Window {
    __TWITCH_LOGS_CONFIG__?: RuntimeConfig;
  }
}

const runtimeConfig = window.__TWITCH_LOGS_CONFIG__ ?? {};

export const workerUrl =
  runtimeConfig.workerUrl ??
  (import.meta.env.VITE_WORKER_URL as string | undefined) ??
  "";

export const configurationIssues = runtimeConfig.configurationIssues ?? [];
