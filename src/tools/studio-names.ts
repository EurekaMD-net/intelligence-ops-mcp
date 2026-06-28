import { z } from "zod";

/** Shared name rule for studio objects (saved queries, monitors) — single source of truth
 *  so the two tool groups can't drift. Defense-in-depth only: the store binds names as
 *  parameters, so this is not the injection guarantee. */
export const STUDIO_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const studioNameSchema = z
  .string()
  .regex(STUDIO_NAME_RE, "name must be 1–64 chars of [A-Za-z0-9_-]");
