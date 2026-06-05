/**
 * Formats concise terminal status lines with ANSI color while keeping the command handlers focused on
 * provider login behavior. The output intentionally stays readable when colors are not interpreted.
 */
export class TerminalStyle {
  static readonly bell = "\u0007";
  static readonly blue = "\u001B[34m";
  static readonly bold = "\u001B[1m";
  static readonly green = "\u001B[32m";
  static readonly gray = "\u001B[90m";
  static readonly red = "\u001B[31m";
  static readonly reset = "\u001B[0m";
  static readonly yellow = "\u001B[33m";

  static detail(label: string, value: string): string {
    return `${TerminalStyle.gray}•${TerminalStyle.reset} ${label}: ${value}`;
  }

  static error(message: string): string {
    return `${TerminalStyle.red}❌${TerminalStyle.reset} ${message}`;
  }

  static info(message: string): string {
    return `${TerminalStyle.blue}ℹ${TerminalStyle.reset} ${message}`;
  }

  static link(label: string, url: string): string {
    return `\u001B]8;;${url}${TerminalStyle.bell}${label}\u001B]8;;${TerminalStyle.bell}`;
  }

  static note(message: string): string {
    return `${TerminalStyle.gray}•${TerminalStyle.reset} ${message}`;
  }

  static rawUrl(url: string): string {
    return `  ${url}`;
  }

  static nextAction(message: string): string {
    return `${TerminalStyle.green}➜${TerminalStyle.reset} ${TerminalStyle.bold}${message}${TerminalStyle.reset}`;
  }

  static progress(message: string): string {
    return `${TerminalStyle.yellow}⏳${TerminalStyle.reset} ${message}`;
  }

  static success(message: string): string {
    return `${TerminalStyle.green}✅${TerminalStyle.reset} ${message}`;
  }
}
