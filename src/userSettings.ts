export const USER_SETTINGS_STORAGE_KEY = "twitch-logs:user-settings";

export interface UserSettings {
  inlineImagesInAllChat: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  inlineImagesInAllChat: false,
};

export function parseUserSettings(value: string | null): UserSettings {
  if (!value) return DEFAULT_USER_SETTINGS;
  try {
    const parsed = JSON.parse(value) as Partial<UserSettings>;
    return {
      inlineImagesInAllChat: parsed.inlineImagesInAllChat === true,
    };
  } catch {
    return DEFAULT_USER_SETTINGS;
  }
}

export function serializeUserSettings(settings: UserSettings): string {
  return JSON.stringify(settings);
}
