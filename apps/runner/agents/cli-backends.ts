import type { OpenClawConfig } from "../config/types.js";

type CliBackend = {
  name: string;
  config?: {
    command?: string;
  };
};

export function resolveCliBackendConfig(
  backendName: string,
  cfg: OpenClawConfig | null | undefined,
): CliBackend | undefined {
  const backends = cfg?.cliBackends;
  if (!Array.isArray(backends)) {
    return undefined;
  }
  return backends.find((backend) => backend?.name === backendName);
}
