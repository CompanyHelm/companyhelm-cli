export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export interface Logger {
  readonly level: LogLevel;
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "INFO").trim().toUpperCase();
  if (normalized === "DEBUG" || normalized === "INFO" || normalized === "WARN" || normalized === "ERROR") {
    return normalized;
  }

  throw new Error(`Invalid log level '${value}'. Expected one of: DEBUG, INFO, WARN, ERROR.`);
}

export function createLogger(levelInput: string | undefined): Logger {
  const level = parseLogLevel(levelInput);
  const threshold = LOG_LEVELS[level];

  const shouldLog = (logLevel: LogLevel): boolean => LOG_LEVELS[logLevel] >= threshold;

  return {
    level,
    debug(message: string): void {
      if (shouldLog("DEBUG")) {
        console.debug(message);
      }
    },
    info(message: string): void {
      if (shouldLog("INFO")) {
        console.info(message);
      }
    },
    warn(message: string): void {
      if (shouldLog("WARN")) {
        console.warn(message);
      }
    },
    error(message: string): void {
      if (shouldLog("ERROR")) {
        console.error(message);
      }
    },
  };
}
