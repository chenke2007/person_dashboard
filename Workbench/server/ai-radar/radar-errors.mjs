// Trusted, user-facing errors raised by the radar HTTP layer. Only instances of
// this class (and RadarRepositoryError) may expose their message through routes.
export class RadarRoutesError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RadarRoutesError";
    this.code = code;
    this.status = status;
  }
}