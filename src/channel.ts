import {SftpError} from './api';

export interface IChannel {
    on(event: string, listener: Function): IChannel;
    send(packet: Uint8Array|string): void;
    close(reason?: CloseReason|number, description?: string): void;
}

export const enum CloseReason {
    NORMAL = 1000,                    // Normal closure; the connection successfully completed whatever purpose for which it was created.
    GOING_AWAY = 1001,                // The endpoint is going away, either because of a server failure or because the browser is navigating away from the page that opened the connection.
    PROTOCOL_ERROR = 1002,            // The endpoint is terminating the connection due to a protocol error.
    UNSUPPORTED = 1003,               // The connection is being terminated because the endpoint received data of a type it cannot accept (for example, a text-only endpoint received binary data).
    NO_STATUS = 1005,                 // Indicates that no status code was provided even though one was expected.
    ABNORMAL = 1006,                  // Used to indicate that a connection was closed abnormally (that is, with no close frame being sent) when a status code is expected.
    BAD_DATA = 1007,	              // The endpoint is terminating the connection because a message was received that contained inconsistent data (e.g., non-UTF-8 data within a text message).
    POLICY_VIOLATION = 1008,          // The endpoint is terminating the connection because it received a message that violates its policy.This is a generic status code, used when codes 1003 and 1009 are not suitable.
    TOO_LARGE = 1009,                 // The endpoint is terminating the connection because a data frame was received that is too large.
    NO_EXTENSIONS_NEGOTIATED = 1010,  // The client is terminating the connection because it expected the server to negotiate one or more extension, but the server didn't.
    UNEXPECTED_CONDITION = 1011,      // The server is terminating the connection because it encountered an unexpected condition that prevented it from fulfilling the request.
    FAILED_TLS_HANDSHAKE = 1015,      // Indicates that the connection was closed due to a failure to perform a TLS handshake (e.g., the server certificate can't be verified).
}

export class WebSocketChannelFactory {

    constructor() {
    }

    connect(address: string, options: any, callback: (err: SftpError, channel: IChannel) => any): void {
        options = options || {};

        var protocols;
        if (options.protocol) protocols = [options.protocol];
        var ws = new WebSocket(address, protocols);
        ws.binaryType = "arraybuffer";

        var channel = new WebSocketChannel(ws, false);

        ws.onopen = () => {
            channel._init();

            callback(null, channel);
        };

        channel.on("close", (err: SftpError) => {
            err = err || new SftpError("Connection closed");

            callback(err, null);
        });
    }
}

class WebSocketChannel implements IChannel {
    private ws: WebSocket;
    private established: boolean;
    private closed: boolean;
    private failed: boolean;
    private onclose: (err: SftpError) => void;

    on(event: string, listener: Function): IChannel {
        if (typeof listener !== "function") throw new SftpError("Listener must be a function");

        switch (event) {
            case "message":
                this.onmessage(<any>listener);
                break;
            case "close":
                this.onclose = <any>listener;
                break;
            default:
                break;
        }
        return this;
    }

    private onmessage(listener: (packet: Uint8Array|string) => void): void {
        this.ws.onmessage = message => {
            if (this.closed) return;

            var packet: Uint8Array|string;
            if (message.data instanceof ArrayBuffer) {
                packet = new Uint8Array(message.data);
            } else {
                packet = message.data;
            }

            listener(packet);
        };
    }

    constructor(ws: WebSocket, established: boolean) {
        this.ws = ws;
        this.established = established;
        this.failed = false;

        ws.onclose = e => {
            var reason = e.code;
            var description = e.reason;

            var message = "Connection failed";
            var code = "EFAILURE";
            switch (reason) {
                case 1000:
                    return this._close(reason, null);
                case 1001:
                    message = "Endpoint is going away";
                    code = "X_GOINGAWAY";
                    break;
                case 1002:
                    message = "Protocol error";
                    code = "EPROTOTYPE";
                    break;
                case 1006:
                    if (this.failed) {
                        message = "Connection refused";
                        code = "ECONNREFUSED";
                        break;
                    }
                    message = "Connection aborted";
                    code = "ECONNABORTED";
                    break;
                case 1007:
                    message = "Invalid message";
                    break;
                case 1008:
                    message = "Prohibited message";
                    break;
                case 1009:
                    message = "Message too large";
                    break;
                case 1010:
                    message = "Connection terminated";
                    code = "ECONNRESET";
                    break;
                case 1011:
                    message = "Connection reset";
                    code = "ECONNRESET";
                    break;
                case 1015:
                    message = "Unable to negotiate secure connection";
                    break;
            }

            var err = <any>new SftpError(message);
            err.code = err.errno = code;
            err.level = "ws";
            err.nativeCode = reason;
            err.clean = e.wasClean;

            this._close(reason, err);
        };
        
        ws.onerror = err => {
            this.failed = true;
        };
    }

    _init(): void {
        this.onclose = null;
        this.established = true;
    }

    _close(kind: number, err: SftpError|any): void {
        if (this.closed) return;
        var onclose = this.onclose;
        this.close();

        if (!err && !this.established) {
            err = new SftpError("Connection refused");
            err.code = err.errno = "ECONNREFUSED";
        }

        if (typeof onclose === "function") {
            window.setTimeout(() => onclose(err), 0);
        } else {
            if (err) throw err;
        }
    }

    close(reason?: number, description?: string): void {
        if (this.closed) return;
        this.closed = true;

        this.onclose = null;
        this.onmessage = null;

        if (!reason) reason = 1000;
        try {
            this.ws.close(reason, description);
        } catch (err) {
            // ignore errors - we are shuting down the socket anyway
        }
    }

    send(packet: Uint8Array|string): void {
        if (this.closed) return;

        try {
            this.ws.send(packet);
        } catch (err) {
            this._close(2, err);
        }
    }

}
