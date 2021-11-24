
export interface IStats {
    mode?: number;
    uid?: number;
    gid?: number;
    size?: number;
    atime?: Date;
    mtime?: Date;
    metadata?: { [key: string]: string; };

    isFile?(): boolean;
    isDirectory?(): boolean;
    isSymbolicLink?(): boolean;
}

export interface IItem {
    filename: string;
    stats: IStats;

    longname?: string;
    path?: string;
}

export const enum RenameFlags {
    NONE = 0,
    OVERWRITE = 1,
    //ATOMIC = 2,
    //NATIVE = 4,
}

export interface SftpError extends Error {
    [k: string]: any;
}

export class SftpError extends Error {
    constructor(message: string) {
        super(message);
    }
    errno?: number;
    code?: string;
    nativeCode?: number;
    description?: string;
}

export type CallbackFunc = (err: SftpError, optional?: any) => void;
