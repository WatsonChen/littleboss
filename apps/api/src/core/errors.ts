/** The external system definitively refused the action (e.g. 4xx). Safe to report as failed. */
export class ExternalRejectedError extends Error {
  override name = 'ExternalRejectedError';
}

/** We cannot tell whether the external system processed the action (timeout, connection cut). */
export class ExternalAmbiguousError extends Error {
  override name = 'ExternalAmbiguousError';
}
