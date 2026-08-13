import type { SettingsInput } from "../../../shared/settings";
import type { UserSettings } from "../../../shared/types";
import { request } from "./http";

export async function fetchSettings(): Promise<UserSettings> {
  const { settings } = await request<{ settings: UserSettings }>("/api/settings");
  return settings;
}

export async function saveSettings(input: SettingsInput): Promise<UserSettings> {
  const { settings } = await request<{ settings: UserSettings }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return settings;
}
