declare module "ws" {
  type WebSocketOptions = {
    headers?: Record<string, string>;
  };

  class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;

    readonly readyState: number;

    constructor(address: string | URL, options?: WebSocketOptions);

    on(event: "open" | "ping" | "pong", listener: () => void): this;
    on(event: "message", listener: (data: Buffer) => void): this;
    on(event: "error", listener: (error: unknown) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    send(data: string | Buffer): void;
    ping(data?: string | Buffer): void;
    close(code?: number, reason?: string | Buffer): void;
    terminate(): void;
  }

  export default WebSocket;
}
