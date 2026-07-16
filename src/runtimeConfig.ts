interface RuntimeConfig {
  convexUrl?: string;
  workerUrl?: string;
}

declare global {
  interface Window {
    __TWITCH_LOGS_CONFIG__?: RuntimeConfig;
  }
}

const runtimeConfig = window.__TWITCH_LOGS_CONFIG__ ?? {};

export const convexUrl =
  runtimeConfig.convexUrl || (import.meta.env.VITE_CONVEX_URL as string | undefined);

export const workerUrl =
  runtimeConfig.workerUrl ??
  (import.meta.env.VITE_WORKER_URL as string | undefined) ??
  "";
