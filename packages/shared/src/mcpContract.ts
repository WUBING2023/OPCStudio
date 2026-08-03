// Minimal shared surface required by the standalone OPC MCP server.
// Keeping this entrypoint explicit prevents the release package from pulling
// the entire workspace while preserving the canonical runtime validators.
export {
  parseArtifactRef,
  parseRunEvents,
} from "./ecosystemContract.js";
export {
  bundleToTemplateShape,
  parseCompanyBundle,
} from "./companyBundle.schema.js";
