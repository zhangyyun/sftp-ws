import {SftpPacket, SftpPacketWriter, SftpPacketReader} from './packet';
import {SftpPacketType, SftpStatusCode, SftpOpenFlags} from './enums';
import {IItem, IStats, SftpError} from './api';

const enum FileType {
    FIFO = 0x1000,
    CHARACTER_DEVICE = 0x2000,
    DIRECTORY = 0x4000,
    BLOCK_DEVICE = 0x6000,
    REGULAR_FILE = 0x8000,
    SYMLINK = 0xA000,
    SOCKET = 0XC000,

    ALL = 0xF000,
}

export class SftpFlags {

    static toNumber(flags: string): SftpOpenFlags {
        if (typeof flags === 'number')
            return (<SftpOpenFlags><any>flags) & SftpOpenFlags.ALL;

        switch (flags) {
            case 'r':
                return SftpOpenFlags.READ;
            case 'r+':
                return SftpOpenFlags.READ | SftpOpenFlags.WRITE;
            case 'w':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.TRUNC;
            case 'w+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.TRUNC | SftpOpenFlags.READ;
            case 'wx':
            case 'xw':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.EXCL;
            case 'wx+':
            case 'xw+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.EXCL | SftpOpenFlags.READ;
            case 'a':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND;
            case 'a+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND | SftpOpenFlags.READ;
            case 'ax':
            case 'xa':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND | SftpOpenFlags.EXCL;
            case 'ax+':
            case 'xa+':
                return SftpOpenFlags.WRITE | SftpOpenFlags.CREATE | SftpOpenFlags.APPEND | SftpOpenFlags.EXCL | SftpOpenFlags.READ;
            default:
                throw new SftpError("Invalid flags '" + flags + "'");
        }
    }

    static fromNumber(flags: number): string[] {
        flags &= SftpOpenFlags.ALL;

        // 'truncate' does not apply when creating a new file
        if ((flags & SftpOpenFlags.EXCL) != 0)
            flags &= SftpOpenFlags.ALL ^ SftpOpenFlags.TRUNC;

        // 'append' does not apply when truncating
        if ((flags & SftpOpenFlags.TRUNC) != 0)
            flags &= SftpOpenFlags.ALL ^ SftpOpenFlags.APPEND;

        // 'read' or 'write' must be specified (or both)
        if ((flags & (SftpOpenFlags.READ | SftpOpenFlags.WRITE)) == 0)
            flags |= SftpOpenFlags.READ;

        // when not creating a new file, only 'read' or 'write' applies
        // (and when creating a new file, 'write' is required)
        if ((flags & SftpOpenFlags.CREATE) == 0)
            flags &= SftpOpenFlags.READ | SftpOpenFlags.WRITE;
        else
            flags |= SftpOpenFlags.WRITE;

        switch (flags) {
            case 1: return ["r"];
            case 2:
            case 3: return ["r+"];
            case 10: return ["wx", "r+"];
            case 11: return ["wx+", "r+"];
            case 14: return ["a"];
            case 15: return ["a+"];
            case 26: return ["w"];
            case 27: return ["w+"];
            case 42: return ["wx"];
            case 43: return ["wx+"];
            case 46: return ["ax"];
            case 47: return ["ax+"];
        }

        // this will never occur
        throw new SftpError("Unsupported flags");
    }
}

export class SftpExtensions {
    public static POSIX_RENAME = "posix-rename@openssh.com"; // "1"
    public static STATVFS = "statvfs@openssh.com"; // "2"
    public static FSTATVFS = "fstatvfs@openssh.com"; // "2"
    public static HARDLINK = "hardlink@openssh.com"; // "1"
    public static FSYNC = "fsync@openssh.com"; // "1"
    public static NEWLINE = "newline@sftp.ws"; // "\n"
    public static NEWLINE2 = "newline"; // "\n"
    public static NEWLINE3 = "newline@vandyke.com"; // "\n"
    public static CHARSET = "charset@sftp.ws"; // "utf-8"
    public static METADATA = "meta@sftp.ws";
    public static VERSIONS = "versions";
    public static VENDOR = "vendor-id";
    [k: string]: any;

    static isKnown(name: string): boolean {
        return SftpExtensions.hasOwnProperty(name);
    }

    static contains(values: string, value: string): boolean {
        // not very fast, but not used often and it gets the job done
        return ("," + values + ",").indexOf("," + value + ",") >= 0;
    }

    static write(writer: SftpPacketWriter, name: string, value: string): void {
        writer.writeString(name);
        writer.writeString(value);
    }

    static read(reader: SftpPacketReader, name: string): any {
        switch (name) {
            case SftpExtensions.VENDOR:
                reader = reader.readStructuredData();
                var res: {[k: string]: any} = {};
                res["vendorName"] = reader.readString();
                res["productName"] = reader.readString();
                res["productVersion"] = reader.readString();
                res["productBuild"] = reader.readInt64();
                return res;

            case SftpExtensions.NEWLINE3:
                reader = reader.readStructuredData();
                return reader.readString();
        }

        if (SftpExtensions.isKnown(name)) {
            return reader.readString();
        } else {
            return reader.readData(true);
        }
    }
}

export class SftpStatus {


    static write(response: SftpPacketWriter, code: SftpStatusCode, message: string) {
        response.type = SftpPacketType.STATUS;
        response.start();

        response.writeInt32(code);
        response.writeString(message);
        response.writeInt32(0);
    }

    static writeSuccess(response: SftpPacketWriter) {
        this.write(response, SftpStatusCode.OK, "OK");
    }
}

export class SftpOptions {
    encoding: string;
    handle: Uint8Array;
    flags: string;
    mode: number;
    start: number;
    end: number;
    autoClose: boolean;
}

export const enum SftpAttributeFlags {
    SIZE        = 0x00000001,
    UIDGID      = 0x00000002,
    PERMISSIONS = 0x00000004,
    ACMODTIME   = 0x00000008,
    BASIC       = 0x0000000F,
    EXTENDED    = 0x80000000,
}

export class SftpAttributes implements IStats {

    //uint32   flags
    //uint64   size           present only if flag SSH_FILEXFER_ATTR_SIZE
    //uint32   uid            present only if flag SSH_FILEXFER_ATTR_UIDGID
    //uint32   gid            present only if flag SSH_FILEXFER_ATTR_UIDGID
    //uint32   permissions    present only if flag SSH_FILEXFER_ATTR_PERMISSIONS
    //uint32   atime          present only if flag SSH_FILEXFER_ATTR_ACMODTIME
    //uint32   mtime          present only if flag SSH_FILEXFER_ATTR_ACMODTIME
    //uint32   extended_count present only if flag SSH_FILEXFER_ATTR_EXTENDED
    //string   extended_type
    //string   extended_data
    //...      more extended data(extended_type - extended_data pairs),
    //so that number of pairs equals extended_count

    flags: SftpAttributeFlags;
    size: number;
    uid: number;
    gid: number;
    mode: number;
    atime: Date;
    mtime: Date;
    nlink: number;

    isDirectory(): boolean {
        return (this.mode & FileType.ALL) == FileType.DIRECTORY;
    }

    isFile(): boolean {
        return (this.mode & FileType.ALL) == FileType.REGULAR_FILE;
    }

    isSymbolicLink(): boolean {
        return (this.mode & FileType.ALL) == FileType.SYMLINK;
    }

    constructor(reader?: SftpPacketReader) {
        if (typeof reader === 'undefined') {
            this.flags = 0;
            return;
        }

        var flags = this.flags = reader.readUint32();

        if (flags & SftpAttributeFlags.SIZE) {
            this.size = reader.readInt64();
        }

        if (flags & SftpAttributeFlags.UIDGID) {
            this.uid = reader.readInt32();
            this.gid = reader.readInt32();
        }

        if (flags & SftpAttributeFlags.PERMISSIONS) {
            this.mode = reader.readUint32();
        }

        if (flags & SftpAttributeFlags.ACMODTIME) {
            this.atime = new Date(1000 * reader.readUint32());
            this.mtime = new Date(1000 * reader.readUint32());
        }
    }

    write(response: SftpPacketWriter): void {
        var flags = this.flags;
        response.writeInt32(flags);

        if (flags & SftpAttributeFlags.SIZE) {
            response.writeInt64(this.size);
        }

        if (flags & SftpAttributeFlags.UIDGID) {
            response.writeInt32(this.uid);
            response.writeInt32(this.gid);
        }

        if (flags & SftpAttributeFlags.PERMISSIONS) {
            response.writeInt32(this.mode);
        }

        if (flags & SftpAttributeFlags.ACMODTIME) {
            response.writeInt32(this.atime.getTime() / 1000);
            response.writeInt32(this.mtime.getTime() / 1000);
        }

        if (flags & SftpAttributeFlags.EXTENDED) {
            response.writeInt32(0);
        }
    }

    from(stats: IStats): void {
        if (stats == null || typeof stats === 'undefined') {
            this.flags = 0;
        } else {
            var flags = 0;

            if (typeof stats.size !== 'undefined') {
                flags |= SftpAttributeFlags.SIZE;
                this.size = stats.size | 0;
            }

            if (typeof stats.uid !== 'undefined' || typeof stats.gid !== 'undefined') {
                flags |= SftpAttributeFlags.UIDGID;
                this.uid = stats.uid | 0;
                this.gid = stats.gid | 0;
            }

            if (typeof stats.mode !== 'undefined') {
                flags |= SftpAttributeFlags.PERMISSIONS;
                this.mode = stats.mode | 0;
            }

            if (typeof stats.atime !== 'undefined' || typeof stats.mtime !== 'undefined') {
                flags |= SftpAttributeFlags.ACMODTIME;
                this.atime = stats.atime; //TODO: make sure its Date
                this.mtime = stats.mtime; //TODO: make sure its Date
            }

            if (typeof (<any>stats).nlink !== 'undefined') {
                this.nlink = (<any>stats).nlink;
            }

            this.flags = flags;
        }
    }

}

