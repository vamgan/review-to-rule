export const ExitCode = {
  success: 0,
  internal: 1,
  refusal: 2,
  validation: 3,
  configuration: 4,
  unsafeRepository: 5,
  unsupported: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: ExitCodeValue,
    readonly kind: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class RefusalError extends DomainError {
  constructor(
    message: string,
    remediation = "Choose a review with a clear, local, static before/after correction.",
  ) {
    super(message, ExitCode.refusal, "not_enforceable", remediation);
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    remediation = "Revise the candidate rule and validate all fixtures again.",
  ) {
    super(message, ExitCode.validation, "validation_failed", remediation);
  }
}

export class ConfigurationError extends DomainError {
  constructor(
    message: string,
    remediation = "Check the command options and local prerequisites.",
  ) {
    super(message, ExitCode.configuration, "configuration", remediation);
  }
}

export class DependencyError extends DomainError {
  constructor(
    message: string,
    remediation = "Check the required local dependency and retry.",
  ) {
    super(message, ExitCode.configuration, "dependency_failed", remediation);
  }
}

export class UnsafeRepositoryError extends DomainError {
  constructor(
    message: string,
    remediation = "Use a clean, explicitly selected repository checkout.",
  ) {
    super(message, ExitCode.unsafeRepository, "unsafe_repository", remediation);
  }
}

export class UnsupportedError extends DomainError {
  constructor(message: string, remediation: string) {
    super(message, ExitCode.unsupported, "unsupported", remediation);
  }
}
