/*
 * Copyright 2020-2024 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  ConnectionOptions,
  Deferred,
  Server,
  ServerInfo,
  Transport,
} from "https://raw.githubusercontent.com/nats-io/nats.deno/v1.29.3/nats-base-client/internal_mod.ts";
import {
  checkOptions,
  DataBuffer,
  deferred,
  delay,
  ErrorCode,
  extractProtocolMessage,
  INFO,
  NatsError,
  render,
} from "https://raw.githubusercontent.com/nats-io/nats.deno/v1.29.3/nats-base-client/internal_mod.ts";

const VERSION = "1.30.3";
const LANG = "nats.ws";

export type WsSocketFactory = (u: string, opts: ConnectionOptions) => Promise<{
  socket: WebSocket;
  encrypted: boolean;
}>;
interface WsConnectionOptions extends ConnectionOptions {
  wsFactory?: WsSocketFactory;
}

export class WsTransport implements Transport {
  version: string;
  lang: string;
  closeError?: Error;
  connected: boolean;
  private done: boolean;
  // @ts-ignore: expecting global WebSocket
  private socket: WebSocket;
  private options!: WsConnectionOptions;
  socketClosed: boolean;
  encrypted: boolean;
  peeked: boolean;

  yields: Uint8Array[];
  signal: Deferred<void>;
  closedNotification: Deferred<void | Error>;

  constructor() {
    this.version = VERSION;
    this.lang = LANG;
    this.connected = false;
    this.done = false;
    this.socketClosed = false;
    this.encrypted = false;
    this.peeked = false;
    this.yields = [];
    this.signal = deferred();
    this.closedNotification = deferred();
  }

  async connect(
    server: Server,
    options: WsConnectionOptions,
  ): Promise<void> {
    const connected = false;
    const connLock = deferred<void>();

    // ws client doesn't support TLS setting
    if (options.tls) {
      connLock.reject(new NatsError("tls", ErrorCode.InvalidOption));
      return connLock;
    }

    this.options = options;
    const u = server.src;
    if (options.wsFactory) {
      const { socket, encrypted } = await options.wsFactory(
        server.src,
        options,
      );
      this.socket = socket;
      this.encrypted = encrypted;
    } else {
      this.encrypted = u.indexOf("wss://") === 0;
      this.socket = new WebSocket(u);
    }
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      if (this.isDiscarded()) {
        return;
      }
      // we don't do anything here...
    };

    this.socket.onmessage = (me: MessageEvent) => {
      if (this.isDiscarded()) {
        return;
      }
      this.yields.push(new Uint8Array(me.data));
      if (this.peeked) {
        this.signal.resolve();
        return;
      }
      const t = DataBuffer.concat(...this.yields);
      const pm = extractProtocolMessage(t);
      if (pm !== "") {
        const m = INFO.exec(pm);
        if (!m) {
          if (options.debug) {
            console.error("!!!", render(t));
          }
          connLock.reject(new Error("unexpected response from server"));
          return;
        }
        try {
          const info = JSON.parse(m[1]) as ServerInfo;
          checkOptions(info, this.options);
          this.peeked = true;
          this.connected = true;
          this.signal.resolve();
          connLock.resolve();
        } catch (err) {
          connLock.reject(err);
          return;
        }
      }
    };

    // @ts-ignore: CloseEvent is provided in browsers
    this.socket.onclose = (evt: CloseEvent) => {
      if (this.isDiscarded()) {
        return;
      }
      this.socketClosed = true;
      let reason: Error | undefined;
      if (this.done) return;
      if (!evt.wasClean) {
        reason = new Error(evt.reason);
      }
      this._closed(reason);
    };

    // @ts-ignore: signature can be any
    this.socket.onerror = (e: ErrorEvent | Event): void => {
      if (this.isDiscarded()) {
        return;
      }
      const evt = e as ErrorEvent;
      const err = new NatsError(
        evt.message,
        ErrorCode.Unknown,
        new Error(evt.error),
      );
      if (!connected) {
        connLock.reject(err);
      } else {
        this._closed(err);
      }
    };
    return connLock;
  }

  disconnect(): void {
    this._closed(undefined, true);
  }

  private async _closed(err?: Error, internal = true): Promise<void> {
    if (this.isDiscarded()) {
      return;
    }
    if (!this.connected) return;
    if (this.done) return;
    this.closeError = err;
    if (!err) {
      while (!this.socketClosed && this.socket.bufferedAmount > 0) {
        await delay(100);
      }
    }
    this.done = true;
    try {
      // 1002 endpoint error, 1000 is clean
      this.socket.close(err ? 1002 : 1000, err ? err.message : undefined);
    } catch (err) {
      // ignore this
    }
    if (internal) {
      this.closedNotification.resolve(err);
    }
  }

  get isClosed(): boolean {
    return this.done;
  }

  [Symbol.asyncIterator]() {
    return this.iterate();
  }

  async *iterate(): AsyncIterableIterator<Uint8Array> {
    while (true) {
      if (this.isDiscarded()) {
        return;
      }
      if (this.yields.length === 0) {
        await this.signal;
      }
      const yields = this.yields;
      this.yields = [];
      for (let i = 0; i < yields.length; i++) {
        if (this.options.debug) {
          console.info(`> ${render(yields[i])}`);
        }
        yield yields[i];
      }
      // yielding could have paused and microtask
      // could have added messages. Prevent allocations
      // if possible
      if (this.done) {
        break;
      } else if (this.yields.length === 0) {
        yields.length = 0;
        this.yields = yields;
        this.signal = deferred();
      }
    }
  }

  isEncrypted(): boolean {
    return this.connected && this.encrypted;
  }

  send(frame: Uint8Array): void {
    if (this.isDiscarded()) {
      return;
    }
    try {
      this.socket.send(frame.buffer);
      if (this.options.debug) {
        console.info(`< ${render(frame)}`);
      }
      return;
    } catch (err) {
      // we ignore write errors because client will
      // fail on a read or when the heartbeat timer
      // detects a stale connection
      if (this.options.debug) {
        console.error(`!!! ${render(frame)}: ${err}`);
      }
    }
  }

  close(err?: Error | undefined): Promise<void> {
    return this._closed(err, false);
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }

  // check to see if we are discarded, as the connection
  // may not have been closed, we attempt it here as well.
  isDiscarded(): boolean {
    if (this.done) {
      this.discard();
      return true;
    }
    return false;
  }

  // this is to allow a force discard on a connection
  // if the connection fails during the handshake protocol.
  // Firefox for example, will keep connections going,
  // so eventually if it succeeds, the client will have
  // an additional transport running. With this
  discard() {
    this.done = true;
    try {
      this.socket?.close();
    } catch (_err) {
      // ignored
    }
  }
}
