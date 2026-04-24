import EventEmitter from "node:events";

import type { TuiMessage } from "$/channels/tui/tui-message.js";

export class TuiBridge extends EventEmitter {
  private readonly _messages: TuiMessage[] = [];

  public push(msg: TuiMessage): void {
    this._messages.push(msg);
    this.emit("message", msg);
  }

  public snapshot(): TuiMessage[] {
    return [...this._messages];
  }
}
