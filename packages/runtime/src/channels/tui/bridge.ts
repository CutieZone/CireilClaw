import EventEmitter from "node:events";

import type { TuiMessage } from "$/channels/tui/tui-message.js";

export class TuiBridge extends EventEmitter {
  private readonly _messages: TuiMessage[] = [];

  push(msg: TuiMessage): void {
    this._messages.push(msg);
    this.emit("message", msg);
  }

  snapshot(): TuiMessage[] {
    return [...this._messages];
  }
}
