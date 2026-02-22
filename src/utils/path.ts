import { homedir } from "node:os";

export function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return p.replace("~", homedir());
  }
  return p;
}
