import { Router } from "express";
import { LoginSchema } from "../../shared/auth";
import type { DB } from "../db/index";
import { findUserByEmail, findUserById, toSessionUser } from "../db/queries/users";
import { verifyPassword } from "../lib/passwords";

export function authRouter(db: DB): Router {
  const router = Router();

  router.post("/login", (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a valid email and password" });
      return;
    }
    const user = findUserByEmail(db, parsed.data.email);
    if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    req.session.userId = user.id;
    res.json({ user: toSessionUser(user) });
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => res.status(204).end());
  });

  router.get("/session", (req, res) => {
    const user = req.session.userId ? findUserById(db, req.session.userId) : undefined;
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    res.json({ user: toSessionUser(user) });
  });

  return router;
}
