import type { LoginInput } from "../../../shared/auth";
import type { SessionUser } from "../../../shared/types";
import { request } from "./http";

export function login(input: LoginInput): Promise<{ user: SessionUser }> {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export function logout(): Promise<void> {
  return request("/api/auth/logout", { method: "POST" });
}

export function fetchSession(): Promise<{ user: SessionUser }> {
  return request("/api/auth/session");
}
