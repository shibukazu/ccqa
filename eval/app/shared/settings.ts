import { z } from "zod";

export const DISPLAY_NAME_MAX = 40;

export const SettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
  emailUpdates: z.boolean(),
});

export type SettingsInput = z.infer<typeof SettingsSchema>;
