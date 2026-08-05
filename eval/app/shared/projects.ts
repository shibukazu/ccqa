import { z } from "zod";

export const PROJECT_NAME_MAX = 60;

export const ProjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(PROJECT_NAME_MAX),
});

export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;
