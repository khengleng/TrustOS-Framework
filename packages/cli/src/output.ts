/**
 * Terminal output.
 *
 * Wrapped in one module so the CLI can be tested by capturing writes instead
 * of by scraping stdout, and so colour can be disabled in one place. Colour is
 * off whenever the stream is not a TTY, or when `NO_COLOR` is set — CI logs and
 * piped output should not carry escape codes.
 */

export interface Output {
  info(message: string): void;
  detail(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  blank(): void;
}

const ESC = '\u001b[';
const codes = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
};

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  /*
   * The one sanctioned read of process.env outside @trustsystem/config.
   *
   * NO_COLOR and FORCE_COLOR are terminal conventions, not application
   * configuration: they are honoured by every well-behaved CLI, they have no
   * validated schema to belong to, and the CLI has no AppConfig — it is not a
   * service. Routing them through the config package would mean inventing an
   * AppConfig for a command that reads no database and binds no port.
   */
  /* eslint-disable no-restricted-properties -- terminal convention, not app config */
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  /* eslint-enable no-restricted-properties */
  return Boolean(stream.isTTY);
}

export function createOutput(options: { color?: boolean } = {}): Output {
  const useColor = options.color ?? colorEnabled();
  const paint = (code: string, message: string) =>
    useColor ? `${code}${message}${codes.reset}` : message;

  return {
    info: (message) => console.log(message),
    detail: (message) => console.log(paint(codes.dim, message)),
    success: (message) => console.log(`${paint(codes.green, '✓')} ${message}`),
    warn: (message) => console.warn(`${paint(codes.yellow, '!')} ${message}`),
    error: (message) => console.error(`${paint(codes.red, '✗')} ${message}`),
    blank: () => console.log(''),
  };
}

/** Collects output instead of printing it. Used by the tests. */
export function createCapturingOutput(): Output & { lines: string[] } {
  const lines: string[] = [];
  const push = (prefix: string) => (message: string) => void lines.push(`${prefix}${message}`);

  return {
    lines,
    info: push(''),
    detail: push(''),
    success: push('✓ '),
    warn: push('! '),
    error: push('✗ '),
    blank: () => void lines.push(''),
  };
}

/** Renders a two-column table with aligned keys. */
export function formatRows(rows: Array<[string, string]>, indent = '  '): string {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${indent}${key.padEnd(width)}  ${value}`).join('\n');
}

export const style = {
  bold: (message: string) => (colorEnabled() ? `${codes.bold}${message}${codes.reset}` : message),
  dim: (message: string) => (colorEnabled() ? `${codes.dim}${message}${codes.reset}` : message),
  cyan: (message: string) => (colorEnabled() ? `${codes.cyan}${message}${codes.reset}` : message),
};
