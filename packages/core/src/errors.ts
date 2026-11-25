export class NestError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = 'NestError';
    this.code = code;
    this.details = details;
  }
}
