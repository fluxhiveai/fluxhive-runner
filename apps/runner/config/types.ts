export type CliBackendConfig = {
  name: string;
  config?: {
    command?: string;
  };
};

export type OpenClawConfig = {
  stateDir?: string;
  gateway?: {
    mode?: "local" | "remote";
    url?: string;
    auth?: {
      token?: string;
      password?: string;
    };
    remote?: {
      url?: string;
      token?: string;
      password?: string;
    };
  };
  cliBackends?: CliBackendConfig[];
  agents?: Array<{
    id: string;
    workspaceDir?: string;
  }>;
};
