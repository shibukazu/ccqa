import { z } from "zod";

export const TASK_TITLE_MAX = 120;
export const TASK_NOTES_MAX = 2000;

export const TaskCreateSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1).max(TASK_TITLE_MAX),
  notes: z.string().max(TASK_NOTES_MAX).optional(),
});

export const TaskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(TASK_TITLE_MAX),
    notes: z.string().max(TASK_NOTES_MAX),
    done: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty update" });

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
