import { Router } from "express";
import { SettingsSchema } from "../../shared/settings";
import type { DB } from "../db/index";
import { findUserById, toUserSettings, updateUserSettings } from "../db/queries/users";
import { requireAuth } from "../middleware/auth";

export function settingsRouter(db: DB): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", (req, res) => {
    const user = findUserById(db, req.session.userId!);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ settings: toUserSettings(user) });
  });

  router.put("/", (req, res) => {
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Display name is required" });
      return;
    }
    updateUserSettings(db, req.session.userId!, parsed.data);
    res.json({ settings: parsed.data });
  });

  return router;
}
