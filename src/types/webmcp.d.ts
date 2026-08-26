/**
 * Minimal typings for the WebMCP browser API.
 *
 * The standard is weeks old and there is no shipped @types package, so this
 * covers only what we actually call. Verified against Chrome's documentation
 * on 2026-08-25. If the standard moves, this file is the first thing to fix.
 */
interface WebMCPToolAnnotations {
  /** True only if the tool changes no state. A false claim here makes the browser skip a confirmation it should have shown. */
  readOnlyHint?: boolean;
  /** True if the tool can surface third-party content to the model. */
  untrustedContentHint?: boolean;
}

interface WebMCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMCPToolAnnotations;
  /** Must resolve to a string. Structured data has to be stringified. */
  /** The options object is not guaranteed: executeTool() omits it entirely. */
  execute: (params: any, options?: { signal?: AbortSignal }) => Promise<string>;
}

interface ModelContext {
  registerTool(tool: WebMCPToolDefinition, options?: { signal?: AbortSignal }): Promise<void>;
  getTools?(): Promise<unknown[]>;
  executeTool?(name: string, args: string, options?: { signal?: AbortSignal }): Promise<string>;
}

interface Document {
  modelContext?: ModelContext;
}
