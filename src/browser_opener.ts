import open from "open";

/**
 * Opens external URLs with the user's default desktop browser through a maintained cross-platform
 * package. The CLI still prints every URL, so browser launch failures never block OAuth completion.
 */
export class BrowserOpener {
  async open(url: string): Promise<boolean> {
    if (!process.stdout.isTTY && !process.stderr.isTTY) {
      return false;
    }

    try {
      await open(url, { wait: false });
      return true;
    } catch {
      return false;
    }
  }
}
