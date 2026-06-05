import { getOAuthProvider, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { BrowserOpener } from "../browser_opener.js";
import type { CliIo } from "../cli_io_interface.js";
import { TerminalStyle } from "../terminal_style.js";

/**
 * Runs the provider OAuth flow supplied by Pi Mono and adapts its terminal callbacks to CompanyHelm's
 * small CLI IO interface. This keeps provider-specific login mechanics outside command parsing.
 */
export class ProviderOauthLoginRunner {
  private readonly browserOpener: BrowserOpener;
  private readonly io: CliIo;

  constructor(io: CliIo, browserOpener: BrowserOpener = new BrowserOpener()) {
    this.browserOpener = browserOpener;
    this.io = io;
  }

  async login(providerId: string): Promise<OAuthCredentials> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Pi OAuth provider is not registered: ${providerId}`);
    }

    return provider.login({
      onAuth: (info) => {
        void this.browserOpener.open(info.url);
        this.io.writeLine(TerminalStyle.info("Trying to open your browser for provider login."));
        this.io.writeLine(TerminalStyle.nextAction("Next step: approve the provider login in your browser."));
        this.io.writeLine(
          TerminalStyle.note("If no browser appears, click the link below or copy/paste the URL into your browser."),
        );
        this.io.writeLine(TerminalStyle.detail("Open link", TerminalStyle.link("Open provider login", info.url)));
        this.io.writeLine(TerminalStyle.note("Copy/paste URL:"));
        this.io.writeLine(TerminalStyle.rawUrl(info.url));
      },
      onProgress: (message) => {
        this.io.writeLine(TerminalStyle.progress(message));
      },
      onPrompt: async () => {
        throw new Error(
          "CompanyHelm CLI did not receive the provider browser callback. Open the login URL on this machine and try again.",
        );
      },
    });
  }
}
