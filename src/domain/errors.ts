/** Base error for all OKF Vault domain failures. */
export class OkfVaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Raised when a concept cannot be located in the bundle. */
export class ConceptNotFoundError extends OkfVaultError {
  constructor(public readonly conceptId: string) {
    super(`Concept not found: ${conceptId}`);
  }
}

/** Raised when a bundle cannot be located. */
export class BundleNotFoundError extends OkfVaultError {
  constructor(public readonly bundleSlug: string) {
    super(`Bundle not found: ${bundleSlug}`);
  }
}

/** Raised when creating a resource whose identity already exists. */
export class ConflictError extends OkfVaultError {}

/** Raised when a document violates the OKF specification. */
export class OkfValidationError extends OkfVaultError {
  constructor(
    message: string,
    public readonly conceptId?: string,
  ) {
    super(message);
  }
}

/** Raised when an operation targets a path outside the bundle root. */
export class BundlePathError extends OkfVaultError {}

export class ReservedConceptIdError extends OkfVaultError {
  constructor(public readonly conceptId: string) {
    super(`Reserved filename cannot be used as a concept: ${conceptId}`);
  }
}
