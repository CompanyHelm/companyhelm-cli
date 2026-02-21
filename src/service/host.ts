import { homedir, userInfo } from "node:os";
import { existsSync } from "node:fs";
import { expandHome } from "../state/db.js";

export interface HostInfo {
    uid: number;
    gid: number;
    home: string;
    codexAuthExists: boolean;
}

export function getHostInfo(codexAuthPath: string): HostInfo {
    const info = userInfo();
    return {
        uid: info.uid,
        gid: info.gid,
        home: homedir(),
        codexAuthExists: existsSync(expandHome(codexAuthPath)),
    };
}
