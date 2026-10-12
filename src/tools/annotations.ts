import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations. Hosts (e.g. Jarvis) gate confirmation on these, so a tool without
 * them is treated as a write. The per-call audit-log row is not counted as a write.
 */

/** Reads the client's database and/or the studio store; writes nothing. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Writes the studio store and replaces what a name resolves to (new current version / upsert). */
export const OVERWRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Deletes studio-store entries; repeating the call removes nothing more. */
export const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
