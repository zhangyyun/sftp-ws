
import {IStats, IItem, RenameFlags, CallbackFunc, SftpError} from './api';
import {IChannel, WebSocketChannelFactory} from './channel';
import {ILogWriter, LogHelper, LogLevel} from './util';
import {SftpPacket, SftpPacketWriter, SftpPacketReader} from './packet';
import {SftpPacketType, SftpStatusCode} from './enums';
import {SftpFlags, SftpStatus, SftpAttributes, SftpExtensions} from './misc';
import {Terminal} from 'xterm';

interface SftpRequest {
    callback: CallbackFunc;
    responseParser: (reply: SftpResponse, callback: CallbackFunc) => void;
    info: SftpCommandInfo;
}

interface SftpResponse extends SftpPacketReader {
    info: SftpCommandInfo;
}

interface SftpCommandInfo extends Object {
    command: string;
    path?: string;
    oldPath?: string;
    newPath?: string;
    targetPath?: string;
    linkPath?: string;
    handle?: any;
    fromHandle?: any;
    toHandle?: any;
    [k: string]: any;
}

class SftpItem implements IItem {
    filename: string;
    longname: string;
    stats: SftpAttributes;
}

class SftpHandle {
    _handle: Uint8Array;
    _this: SftpClientCore;

    constructor(handle: Uint8Array, owner: SftpClientCore) {
        this._handle = handle;
        this._this = owner;
    }

    toString(): string {
        var value = "0x";
        for (var i = 0; i < this._handle.length; i++) {
            var b = this._handle[i];
            var c = b.toString(16);
            if (b < 16) value += "0";
            value += c;
        }
        return value;
    }
}

class SftpFeature {
    static HARDLINK = "LINK";
    static POSIX_RENAME = "POSIX_RENAME";
    static COPY_FILE = "COPY_FILE";
    static COPY_DATA = "COPY_DATA";
    static CHECK_FILE_HANDLE = "CHECK_FILE_HANDLE";
    static CHECK_FILE_NAME = "CHECK_FILE_NAME";
}

class SftpClientCore {
    private static _nextSessionId = 1;
    private _sessionId: number;

    private _host: IChannel
    private _id: number;
    private _requests: SftpRequest[];
    private _ready: boolean;
    private _extensions: {[k: string]: any};
    private _features: {[k: string]: string};

    protected _log: ILogWriter;
    private _debug: boolean;
    private _trace: boolean;

    private _maxReadBlockLength: number;
    private _maxWriteBlockLength: number;

    private _bytesReceived: number;
    private _bytesSent: number;

    private getRequest(type: SftpPacketType|string): SftpPacketWriter {
        var request = new SftpPacketWriter(this._maxWriteBlockLength + 1024);

        request.type = type;
        request.id = this._id;

        if (type == SftpPacketType.INIT) {
            if (this._id != null)
                throw new SftpError("Already initialized");
            this._id = 1;
        } else {
            this._id = (this._id + 1) & 0xFFFFFFFF;
        }

        request.start();
        return request;
    }

    private writeStats(packet: SftpPacketWriter, attrs?: IStats): void {
        var pattrs = new SftpAttributes();
        pattrs.from(attrs);
        pattrs.write(packet);
    }

    constructor() {
        this._sessionId = SftpClientCore._nextSessionId++;
        this._host = null;
        this._id = null;
        this._ready = false;
        this._requests = [];
        this._extensions = {};
        this._features = {};

        this._maxWriteBlockLength = 32 * 1024;
        this._maxReadBlockLength = 256 * 1024;

        this._bytesReceived = 0;
        this._bytesSent = 0;
    }

    private execute(request: SftpPacketWriter, callback: CallbackFunc, responseParser: (response: SftpResponse, callback: CallbackFunc) => void, info: SftpCommandInfo): void {
        if (!this._host) {
            window.setTimeout(() => {
                var error = this.createError(SftpStatusCode.NO_CONNECTION, "Not connected", info);
                callback(error);
            }, 0);
            return;
        }

        if (typeof this._requests[request.id] !== 'undefined')
            throw new SftpError("Duplicate request");

        var packet = request.finish();

        if (this._debug) {
            // logging
            var meta: {[k: string]: any} = {};
            meta["session"] = this._sessionId;
            if (request.type != SftpPacketType.INIT) meta["req"] = request.id;
            meta["type"] = SftpPacket.toString(request.type);
            meta["length"] = packet.length;
            if (this._trace) meta["raw"] = packet;

            if (request.type == SftpPacketType.INIT) {
                this._log.debug(meta, "[%d] - Sending initialization request", this._sessionId);
            } else {
                this._log.debug(meta, "[%d] #%d - Sending request", this._sessionId, request.id);
            }
        }

        this._host.send(packet);
        this._bytesSent += packet.length;

        this._requests[request.id] = { callback: callback, responseParser: responseParser, info: info };
    }

    _init(host: IChannel, log: ILogWriter, callback: (err: SftpError) => any): void {
        if (this._host) throw new SftpError("Already bound");

        this._host = host;
        this._extensions = {};

        this._log = log;

        // determine the log level now to speed up logging later
        var level = LogHelper.getLevel(log);
        this._debug = level <= LogLevel.DEBUG;
        this._trace = level <= LogLevel.TRACE;

        var request = this.getRequest(SftpPacketType.INIT);

        request.writeInt32(3); // SFTPv3

        var info = { command: "init" };

        this.execute(request, callback, (response, cb) => {

            if (response.type != SftpPacketType.VERSION) {
                host.close(3002);
                var error = this.createError(SftpStatusCode.BAD_MESSAGE, "Unexpected message", info);
                return cb(new SftpError("Protocol violation"));
            }

            var version = response.readInt32();
            if (version != 3) {
                host.close(3002);
                var error = this.createError(SftpStatusCode.BAD_MESSAGE, "Unexpected protocol version", info);
                return cb(error);
            }

            while ((response.length - response.position) >= 4) {
                var extensionName = response.readString();
                var value = SftpExtensions.read(response, extensionName);

                if (extensionName.indexOf("@openssh.com") === (extensionName.length - 12)) {
                    // OpenSSH extensions may occur multiple times
                    var val = <string>this._extensions[extensionName];
                    if (typeof val === "undefined") {
                        val = value;
                    } else {
                        val += "," + value;
                    }
                }

                this._extensions[extensionName] = value;
            }

            this._log.debug(this._extensions, "[%d] - Server extensions", this._sessionId);

            if (SftpExtensions.contains(this._extensions[SftpExtensions.HARDLINK], "1")) {
                this._features[SftpFeature.HARDLINK] = SftpExtensions.HARDLINK;
            }

            if (SftpExtensions.contains(this._extensions[SftpExtensions.POSIX_RENAME], "1")) {
                this._features[SftpFeature.POSIX_RENAME] = SftpExtensions.POSIX_RENAME;
            }

            this._ready = true;
            cb(null);
        }, info);
    }

    _process(packet: Uint8Array): void {
        this._bytesReceived += packet.length;
        var response = <SftpResponse>new SftpPacketReader(packet);

        if (this._debug) {
            var meta: {[k: string]: any} = {};
            meta["session"] = this._sessionId;
            if (response.type != SftpPacketType.VERSION) meta["req"] = response.id;
            meta["type"] = SftpPacket.toString(response.type);
            meta["length"] = response.length;
            if (this._trace) meta["raw"] = response.buffer;

            if (response.type == SftpPacketType.VERSION) {
                this._log.debug(meta, "[%d] - Received version response", this._sessionId);
            } else {
                this._log.debug(meta, "[%d] #%d - Received response", this._sessionId, response.id);
            }
        }

        var request = this._requests[response.id];

        if (typeof request === 'undefined')
            throw new SftpError("Unknown response ID");

        delete this._requests[response.id];

        response.info = request.info;

        request.responseParser.call(this, response, request.callback);
    }

    end(): void {
        var host = this._host;
        if (host) {
            this._host = null;
            host.close();
        }
        this.failRequests(SftpStatusCode.CONNECTION_LOST, "Connection closed");
    }

    private failRequests(code: SftpStatusCode, message: string): void {
        var requests = this._requests;
        this._requests = [];

        requests.forEach(request => {
            var error = this.createError(code, message, request.info);
            request.callback(error);
        });
    }

    open(path: string, flags: string, attrs: IStats, callback: (err: SftpError, handle: any) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        var request = this.getRequest(SftpPacketType.OPEN);

        request.writeString(path);
        request.writeInt32(SftpFlags.toNumber(flags));
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseHandle, { command: "open", path: path });
    }

    close(handle: any, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.CLOSE);

        request.writeData(h);

        this.execute(request, callback, this.parseStatus, { command: "close", handle: handle });
    }

    read(handle: any, buffer: Uint8Array, offset: number, length: number, position: number, callback: (err: SftpError, data: {buffer: Uint8Array, bytesRead: number}) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);
        if (buffer) this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        // make sure the length is within reasonable limits
        if (length > this._maxReadBlockLength)
            length = this._maxReadBlockLength;

        var request = this.getRequest(SftpPacketType.READ);

        request.writeData(h);
        request.writeInt64(position);
        request.writeInt32(length);

        this.execute(request, callback, (response, cb) => this.parseData(response, cb, 0, h, buffer, offset, length, position), { command: "read", handle: handle });
    }

    write(handle: any, buffer: Uint8Array, offset: number, length: number, position: number, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);
        this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        if (length > this._maxWriteBlockLength)
            throw new SftpError("Length exceeds maximum allowed data block length");

        var request = this.getRequest(SftpPacketType.WRITE);

        request.writeData(h);
        request.writeInt64(position);
        request.writeData(buffer, offset, offset + length);

        this.execute(request, callback, this.parseStatus, { command: "write", handle: handle });
    }

    lstat(path: string, callback: (err: SftpError, attrs: IStats) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.LSTAT, [path], callback, this.parseAttribs, { command: "lstat", path: path });
    }

    fstat(handle: any, callback: (err: SftpError, attrs: IStats) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.FSTAT);

        request.writeData(h);

        this.execute(request, callback, this.parseAttribs, { command: "fstat", handle: handle });
    }

    setstat(path: string, attrs: IStats, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        var request = this.getRequest(SftpPacketType.SETSTAT);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "setstat", path: path });
    }

    fsetstat(handle: any, attrs: IStats, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.FSETSTAT);

        request.writeData(h);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "fsetstat", handle: handle });
    }

    opendir(path: string, callback: (err: SftpError, handle: any) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.OPENDIR, [path], callback, this.parseHandle, { command: "opendir", path: path });
    }

    readdir(handle: any, callback: (err: SftpError, items: IItem[]) => any): void {
        this.checkCallback(callback);
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.READDIR);

        request.writeData(h);

        this.execute(request, callback, this.parseItems, { command: "readdir", handle: handle });
    }

    unlink(path: string, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.REMOVE, [path], callback, this.parseStatus, { command: "unlink", path: path });
    }

    mkdir(path: string, attrs: IStats, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        var request = this.getRequest(SftpPacketType.MKDIR);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "mkdir", path: path });
    }

    rmdir(path: string, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.RMDIR, [path], callback, this.parseStatus, { command: "rmdir", path: path });
    }

    realpath(path: string, callback: (err: SftpError, resolvedPath: string) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.REALPATH, [path], callback, this.parsePath, { command: "realpath", path: path });
    }

    stat(path: string, callback: (err: SftpError, attrs: IStats) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.STAT, [path], callback, this.parseAttribs, { command: "stat", path: path });
    }

    rename(oldPath: string, newPath: string, flags: RenameFlags, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        oldPath = this.checkPath(oldPath, 'oldPath');
        newPath = this.checkPath(newPath, 'newPath');

        var command;
        var info = { command: "rename", oldPath: oldPath, newPath: newPath, flags: flags };
        switch (flags) {
            case RenameFlags.OVERWRITE:
                command = SftpFeature.POSIX_RENAME;
                break;
            case RenameFlags.NONE:
                command = SftpPacketType.RENAME;
                break;
            default:
                window.setTimeout(() => callback(this.createError(SftpStatusCode.OP_UNSUPPORTED, "Unsupported rename flags", info)), 0);
                break;
        }

        this.command(command, [oldPath, newPath], callback, this.parseStatus, info);
    }

    readlink(path: string, callback: (err: SftpError, linkString: string) => any): void {
        this.checkCallback(callback);
        path = this.checkPath(path, 'path');

        this.command(SftpPacketType.READLINK, [path], callback, this.parsePath, { command: "readlink", path: path });
    }

    symlink(targetPath: string, linkPath: string, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        targetPath = this.checkPath(targetPath, 'targetPath');
        linkPath = this.checkPath(linkPath, 'linkPath');

        this.command(SftpPacketType.SYMLINK, [targetPath, linkPath], callback, this.parseStatus, { command: "symlink", targetPath: targetPath, linkPath: linkPath });
    }

    link(oldPath: string, newPath: string, callback: (err: SftpError) => any): void {
        this.checkCallback(callback);
        oldPath = this.checkPath(oldPath, 'oldPath');
        newPath = this.checkPath(newPath, 'newPath');

        this.command(SftpFeature.HARDLINK, [oldPath, newPath], callback, this.parseStatus, { command: "link", oldPath: oldPath, newPath: newPath });
    }

    private checkCallback(callback: any): void {
        if (typeof callback !== "function") throw new SftpError("Callback must be a function");
    }

    private toHandle(handle: { _handle: Uint8Array; _this: SftpClientCore }): Uint8Array {
        if (!handle) {
            throw new SftpError("Missing handle");
        } else if (typeof handle === 'object') {
            if (SftpPacket.isBuffer(handle._handle) && handle._this == this)
                return handle._handle;
        }

        throw new SftpError("Invalid handle");
    }

    private checkBuffer(buffer: Uint8Array, offset: number, length: number): void {
        if (!SftpPacket.isBuffer(buffer))
            throw new SftpError("Invalid buffer");

        if (typeof offset !== 'number' || offset < 0)
            throw new SftpError("Invalid offset");

        if (typeof length !== 'number' || length < 0)
            throw new SftpError("Invalid length");

        if ((offset + length) > buffer.length)
            throw new SftpError("Offset or length is out of bands");
    }

    private checkPath(path: string, name: string): string {
        if (path.length == 0)
             throw new SftpError("Empty " + name);
        if (path[0] === '~') {
            if (path[1] === '/') {
                path = "." + path.substr(1);
            } else if (path.length == 1) {
                path = ".";
            }
        }
        return path;
    }

    private checkPosition(position: number): void {
        if (typeof position !== 'number' || position < 0 || position > 0x7FFFFFFFFFFFFFFF)
            throw new SftpError("Invalid position");
    }

    private command(command: SftpPacketType | string, args: string[], callback: CallbackFunc, responseParser: (response: SftpResponse, callback: CallbackFunc) => void, info: SftpCommandInfo): void {
        if (typeof command !== "number") command = this._features[command];

        if (!command) {
            window.setTimeout(() => callback(this.createError(SftpStatusCode.OP_UNSUPPORTED, "Operation not supported", info)), 0);
            return;
        }

        var request = this.getRequest(command);

        for (var i = 0; i < args.length; i++) {
            request.writeString(args[i]);
        }

        this.execute(request, callback, responseParser, info);
    }

    private readStatus(response: SftpResponse): SftpError {
        var nativeCode = response.readInt32();
        var message = response.readString();
        if (nativeCode == SftpStatusCode.OK)
            return null;

        var info = response.info;
        return this.createError(nativeCode, message, info);
    }

    private readItem(response: SftpResponse): IItem {
        var item = new SftpItem();
        item.filename = response.readString();
        item.longname = response.readString();
        item.stats = new SftpAttributes(response);
        return item;
    }

    private createError(nativeCode: number, message: string, info: SftpCommandInfo): SftpError {
        var code;
        var errno;
        switch (nativeCode) {
            case SftpStatusCode.EOF:
                code = "EOF";
                errno = 1;
                break;
            case SftpStatusCode.NO_SUCH_FILE:
                code = "ENOENT";
                errno = 34;
                break;
            case SftpStatusCode.PERMISSION_DENIED:
                code = "EACCES";
                errno = 3;
                break;
            case SftpStatusCode.OK:
            case SftpStatusCode.FAILURE:
            case SftpStatusCode.BAD_MESSAGE:
                code = "EFAILURE";
                errno = -2;
                break;
            case SftpStatusCode.NO_CONNECTION:
                code = "ENOTCONN";
                errno = 31;
                break;
            case SftpStatusCode.CONNECTION_LOST:
                code = "ESHUTDOWN";
                errno = 46;
                break;
            case SftpStatusCode.OP_UNSUPPORTED:
                code = "ENOSYS";
                errno = 35;
                break;
            case SftpStatusCode.BAD_MESSAGE:
                code = "ESHUTDOWN";
                errno = 46;
                break;
            default:
                code = "UNKNOWN";
                errno = -1;
                break;
        }

        var command = info.command;
        var arg = info.path || info.handle;
        if (typeof arg === "string")
            arg = "'" + arg + "'";
        else if (arg)
            arg = new String(arg);
        else
            arg = "";

        var error = new SftpError(code + ", " + command + " " + arg);
        error['errno'] = errno;
        error['code'] = code;

        for (var name in info) {
            if (name == "command") continue;
            if (info.hasOwnProperty(name)) error[name] = info[name];
        }

        error['nativeCode'] = nativeCode;
        error['description'] = message;
        return error;
    }

    private checkResponse(response: SftpResponse, expectedType: number, callback: CallbackFunc): boolean {
        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                callback(error);
                return false;
            }
        }

        if (response.type != expectedType)
            throw new SftpError("Unexpected packet received");

        return true;
    }

    private parseStatus(response: SftpResponse, callback: (err: SftpError) => any): void {
        if (!this.checkResponse(response, SftpPacketType.STATUS, callback))
            return;

        callback(null);
    }

    private parseAttribs(response: SftpResponse, callback: (err: SftpError, attrs: IStats) => any): void {
        if (!this.checkResponse(response, SftpPacketType.ATTRS, callback))
            return;

        var attrs = new SftpAttributes(response);
        delete attrs.flags;

        callback(null, attrs);
    }

    private parseHandle(response: SftpResponse, callback: (err: SftpError, handle: any) => any): void {
        if (!this.checkResponse(response, SftpPacketType.HANDLE, callback))
            return;

        var handle = response.readData(true);

        callback(null, new SftpHandle(handle, this));
    }

    private parsePath(response: SftpResponse, callback: (err: SftpError, path?: string) => any): void {
        if (!this.checkResponse(response, SftpPacketType.NAME, callback))
            return;

        var count = response.readInt32();
        if (count != 1)
            throw new SftpError("Invalid response");

        var path = response.readString();

        callback(null, path);
    }

    private parseData(response: SftpResponse, callback: (err: SftpError, data: {buffer: Uint8Array, bytesRead: number}) => any, retries: number, h: Uint8Array, buffer: Uint8Array, offset: number, length: number, position: number): void {
        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                if (error['nativeCode'] == SftpStatusCode.EOF) {
                    buffer = buffer ? buffer.slice(offset, 0) : new Uint8Array(0);
                    callback(null, {buffer: buffer, bytesRead: 0});
                } else {
                    callback(error, null);
                }
                return;
            }
        }

        var data = response.readData(false);

        if (data.length > length)
            throw new SftpError("Received too much data");

        length = data.length;
        if (length == 0) {
            // workaround for broken servers such as Globalscape 7.1.x that occasionally send empty data

            if (retries > 4) {
                var error = this.createError(SftpStatusCode.FAILURE, "Unable to read data", response.info);
                error['code'] = "EIO";
                error['errno'] = 55;

                callback(error, null);
                return;
            }

            var request = this.getRequest(SftpPacketType.READ);
            request.writeData(h);
            request.writeInt64(position);
            request.writeInt32(length);

            this.execute(request, callback, (response, cb) => this.parseData(response, cb, retries + 1, h, buffer, offset, length, position), response.info);
            return;
        }

        if (!buffer) {
            buffer = data;
        } else {
            buffer.set(data, offset);
        }

        callback(null, {buffer: buffer, bytesRead: length});
    }

    private parseItems(response: SftpResponse, callback: (err: SftpError, items: IItem[]) => any): void {

        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                if (error['nativeCode'] == SftpStatusCode.EOF)
                    callback(null, []);
                else
                    callback(error, null);
                return;
            }
        }

        if (response.type != SftpPacketType.NAME)
            throw new SftpError("Unexpected packet received");

        var count = response.readInt32();

        var items: IItem[] = [];
        for (var i = 0; i < count; i++) {
            items[i] = this.readItem(response);
        }

        callback(null, items);
    }

}

export class SftpClient extends SftpClientCore {

    private _bound: boolean;
    private _term: Terminal;

    constructor(term: Terminal) {
        super();
        this._term = term;
    }

    connect(address: string, options: any, callback: (err: SftpError) => void) {
        var factory = new WebSocketChannelFactory();
        factory.connect(address, options, (err, channel) => {
            if (err) return callback(err);

            this._bind(channel, options, callback);
        });
    }

    protected _bind(channel: IChannel, options: any, callback: (err: SftpError) => void): void {
        function utf8_to_b64(str: string) {
            return window.btoa(unescape(encodeURIComponent( str )));
        }

        function b64_to_utf8(str: string) {
            return decodeURIComponent(escape(window.atob( str )));
        }

        if (this._bound) throw new SftpError("Already bound");
        this._bound = true;

        var log = LogHelper.toLogWriter(options && options.log);

        this._term.onData(function (data: string) {
            channel.send(JSON.stringify({ type: "stdin", data: utf8_to_b64(data) }));
        });
        this._term.onResize(function (data: { cols: number, rows: number }) {
            channel.send(JSON.stringify({ type: "resize", ...data }));
        });

        this._init(channel, log, err => {
            if (err) {
                this.end();
                this._bound = false;
                callback(err);
            } else {
                callback(null);
            }
        });

        channel.on("message", (packet: Uint8Array|string) => {
            if (typeof packet === "string") {
                const msg = JSON.parse(packet);
                switch (msg.type) {
                    case "stdout":
                    case "stderr":
                        this._term.write(b64_to_utf8(msg.data));
                }
            } else {
                try {
                    this._process(packet);
                } catch (err) {
                    this._log.error("process sftp error %s", err.message);
                }
            }
        });

        channel.on("close", (err: SftpError) => {
            this.end();
            this._bound = false;
        });
    }

    list(path: string, callback: (err: SftpError, items: IItem[]) => void): void {
        var handle: any;
        var res: IItem[] = [];
        let that = this;

        function read(err: SftpError, items: IItem[]) {
            if (err || items.length === 0) {
                that.close(handle, (err) => {
                    if (err)
                        that._log.error("readdir close handle error %s", err.message);
                });
                return callback(err, res);
            }

            res.push(...items);
            that.readdir(handle, read);
        }

        this.opendir(path, (err, h) => {
            if (err) return callback(err, null);

            handle = h;
            this.readdir(handle, read);
        });
    }

    upload(path: string, files: FileList, callback: (err: SftpError) => void): void {
        for (var i = 0; i < files.length; i++) {
            var f = files.item(i);

            this.open(path+f.name, "w", null, (err, h) => {
                if (err) return callback(err)

                f.arrayBuffer().then(buffer => {
                    let offset = 0;
                    let left = buffer.byteLength;
                    let length = left;
                    let charptr = new Uint8Array(buffer);
                    const limit = 32*1024;
                    let that = this;

                    function write_cb(err: SftpError) {
                       if (err) {
                            that.close(h, (err) => {
                                if (err)
                                   that._log.error("upload close handle failed %s", err.message);
                            });
                            callback(err);
                            return;
                        }

                        offset += length;
                        left -= length;

                        if (left == 0) {
                            that.close(h, (err) => {
                                if (err)
                                   that._log.error("upload close handle failed %s", err.message);
                            });
                            callback(null);
                            return;
                        }

                        length = left;
                        if (left > limit)
                            length = limit;
                        that.write(h, charptr, offset, length, offset, write_cb);
                    }

                    if (left > limit)
                        length = limit;
                    this.write(h, charptr, offset, length, offset, write_cb);
                });
            })
        }
    }
}
