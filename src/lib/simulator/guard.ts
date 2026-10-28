// The simulated portal runs only in a development build with the flag set
// (in .env.local). A production build ignores the flag, so it can never
// serve fake data. Kept separate from the simulator so checking the guard
// never loads simulator code.
export function simulatorEnabled(env: { NODE_ENV?: string; ENABLE_SIMULATOR?: string } = process.env): boolean {
  return env.NODE_ENV === "development" && env.ENABLE_SIMULATOR === "true";
}
