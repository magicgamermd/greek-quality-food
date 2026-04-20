// Vitest global setup - runs before every test file.
//
// We force a deterministic JWT_SECRET here so unit tests that boot the real
// server via buildServer() pass the "JWT_SECRET is required" assertion added
// in src/index.ts. The value is a well-known test-only constant - it is never
// used outside the vitest process and never shipped with the bundle.
process.env.JWT_SECRET =
  process.env.JWT_SECRET ||
  "test-only-jwt-secret-do-not-use-in-any-deployed-environment";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
