import dotenv from "dotenv";

// RFPILOT_ENV_FILE selects one env file and skips .env / .env.local entirely. The local Docker
// stack (deploy/local) uses it so a developer's .env.local, which may point at shared databases
// or hold provider keys, can never leak into a stack run.
const exclusiveEnvFile = process.env.RFPILOT_ENV_FILE?.trim();
if (exclusiveEnvFile) {
  const result = dotenv.config({ path: exclusiveEnvFile, override: true });
  if (result.error) throw new Error(`RFPILOT_ENV_FILE could not be loaded: ${exclusiveEnvFile}`);
} else {
  dotenv.config();
  dotenv.config({ path: ".env.local", override: true });
}
