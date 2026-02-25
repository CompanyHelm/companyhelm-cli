import pino from "pino";
import pretty from "pino-pretty";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const PINO_LOG_LEVELS: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

export interface Logger {
  readonly level: LogLevel;
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface CreateLoggerOptions {
  daemonMode?: boolean;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "INFO").trim().toUpperCase();
  if (normalized === "DEBUG" || normalized === "INFO" || normalized === "WARN" || normalized === "ERROR") {
    return normalized;
  }

  throw new Error(`Invalid log level '${value}'. Expected one of: DEBUG, INFO, WARN, ERROR.`);
}

function createConsoleLogger(level: LogLevel): Logger {
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

function createDaemonLogger(level: LogLevel): Logger {
  const pinoLogger = pino(
    {
      level: PINO_LOG_LEVELS[level],
    },
    pretty({
      colorize: process.stdout.isTTY,
      ignore: "pid,hostname",
      singleLine: true,
      sync: true,
      translateTime: "SYS:standard",
    }),
  );

  return {
    level,
    debug(message: string): void {
      pinoLogger.debug(message);
    },
    info(message: string): void {
      pinoLogger.info(message);
    },
    warn(message: string): void {
      pinoLogger.warn(message);
    },
    error(message: string): void {
      pinoLogger.error(message);
    },
  };
}

export function createLogger(levelInput: string | undefined, options?: CreateLoggerOptions): Logger {
  const level = parseLogLevel(levelInput);
  if (options?.daemonMode) {
    return createDaemonLogger(level);
  }

  return createConsoleLogger(level);
}
