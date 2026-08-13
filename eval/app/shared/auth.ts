import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(72),
});

export type LoginInput = z.infer<typeof LoginSchema>;
