type LogMethod = (...args: unknown[]) => void;

export type SubsystemLogger = {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  debug: LogMethod;
  trace: LogMethod;
  fatal: LogMethod;
  child: (label: string) => SubsystemLogger;
};

function buildLogger(prefix: string): SubsystemLogger {
  const format = (level: string, args: unknown[]) => {
    const stamp = new Date().toISOString();
    return [`[${stamp}] [${prefix}] [${level}]`, ...args];
  };

  return {
    info: (...args) => console.log(...format("INFO", args)),
    warn: (...args) => console.warn(...format("WARN", args)),
    error: (...args) => console.error(...format("ERROR", args)),
    debug: (...args) => console.debug(...format("DEBUG", args)),
    trace: (...args) => console.trace(...format("TRACE", args)),
    fatal: (...args) => console.error(...format("FATAL", args)),
    child: (label: string) => buildLogger(`${prefix}.${label}`),
  };
}

export function createSubsystemLogger(scope: string): SubsystemLogger {
  return buildLogger(scope);
}
