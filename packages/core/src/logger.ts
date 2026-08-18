export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export class ConsoleLogger implements Logger {
  constructor(private prefix: string = '[OpenplanRecorder]') {}

  info(message: string, ...args: unknown[]): void {
    console.log(`${this.prefix} [INFO] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.prefix} [WARN] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`${this.prefix} [ERROR] ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    console.debug(`${this.prefix} [DEBUG] ${message}`, ...args);
  }
}

export const logger = new ConsoleLogger();
