/** 轻量日志：带时间戳与级别，关键写操作留痕，不记录任何敏感信息。 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function format(level: Level, scope: string, message: string): string {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `${COLORS[level]}[${time}] ${level.toUpperCase().padEnd(5)} ${scope}\x1b[0m ${message}`;
}

function output(level: Level, scope: string, message: string) {
  const line = format(level, scope, message);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string) => output('debug', scope, message),
    info: (message: string) => output('info', scope, message),
    warn: (message: string) => output('warn', scope, message),
    error: (message: string, error?: unknown) => {
      const detail = error instanceof Error ? ` :: ${error.message}` : error ? ` :: ${String(error)}` : '';
      output('error', scope, message + detail);
    },
  };
}

export const logger = createLogger('app');
