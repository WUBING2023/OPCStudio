export const CLI_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  unavailable: 3,
  notFound: 4,
  conflict: 5,
  unauthorized: 6,
  capabilityBlocked: 7,
  acceptanceFailed: 8,
  interrupted: 130,
} as const;

export type CliExitCode = typeof CLI_EXIT[keyof typeof CLI_EXIT];

export interface CliErrorShape {
  code: string;
  message: string;
  details: Record<string, unknown>;
  retryable: boolean;
}

export interface CliErrorEnvelope {
  ok: false;
  error: CliErrorShape;
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
    readonly exitCode: CliExitCode = CLI_EXIT.failed,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function cliErrorEnvelope(error: CliError): CliErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
    },
  };
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "invalid_ecosystem_contract") {
    const contractError = error as { message?: unknown; contract?: unknown; issues?: unknown };
    return new CliError(
      "invalid_ecosystem_contract",
      typeof contractError.message === "string" ? contractError.message : "External contract is invalid",
      {
        contract: contractError.contract,
        issues: Array.isArray(contractError.issues) ? contractError.issues : [],
      },
      false,
      CLI_EXIT.failed,
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CliError("interrupted", "Operation interrupted", {}, false, CLI_EXIT.interrupted);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("internal_error", message, {}, false, CLI_EXIT.failed);
}

export function localValidationError(message: string, details: Record<string, unknown> = {}): CliError {
  return new CliError("invalid_arguments", message, details, false, CLI_EXIT.usage);
}
