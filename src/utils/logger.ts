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
  const formatMessage = (logLevel: LogLevel, message: string): string => {
    const now = new Date();
    const pad2 = (value: number): string => String(value).padStart(2, "0");
    const pad3 = (value: number): string => String(value).padStart(3, "0");
    const timestamp =
      `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
      `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${pad3(now.getMilliseconds())}`;
    return `[${timestamp}] ${logLevel}: ${message}`;
  };

  return {
    level,
    debug(message: string): void {
      if (shouldLog("DEBUG")) {
        console.debug(formatMessage("DEBUG", message));
      }
    },
    info(message: string): void {
      if (shouldLog("INFO")) {
        console.info(formatMessage("INFO", message));
      }
    },
    warn(message: string): void {
      if (shouldLog("WARN")) {
        console.warn(formatMessage("WARN", message));
      }
    },
    error(message: string): void {
      if (shouldLog("ERROR")) {
        console.error(formatMessage("ERROR", message));
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
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
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
