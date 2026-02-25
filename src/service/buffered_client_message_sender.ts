import type { ClientMessage } from "@companyhelm/protos";
import type { Logger } from "../utils/logger.js";

export interface GrpcEventSink<TEvent> {
  send(event: TEvent): Promise<void>;
}

export interface BufferedGrpcEventSenderOptions {
  maxBufferedEvents: number;
  logger: Pick<Logger, "warn" | "debug">;
  eventName?: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BufferedGrpcEventSender<TEvent> implements GrpcEventSink<TEvent> {
  private readonly maxBufferedEvents: number;
  private readonly logger: Pick<Logger, "warn" | "debug">;
  private readonly eventName: string;
  private readonly bufferedEvents: TEvent[] = [];
  private channel: GrpcEventSink<TEvent> | null = null;
  private flushing = false;
  private droppedEvents = 0;

  constructor(options: BufferedGrpcEventSenderOptions) {
    this.maxBufferedEvents = Math.max(1, options.maxBufferedEvents);
    this.logger = options.logger;
    this.eventName = options.eventName ?? "event";
  }

  bind(channel: GrpcEventSink<TEvent>): void {
    this.channel = channel;
    if (this.bufferedEvents.length > 0) {
      this.logger.debug(
        `Bound command channel and attempting to flush ${this.bufferedEvents.length} buffered gRPC ${this.eventName}(s).`,
      );
    }
    void this.flush();
  }

  unbind(channel?: GrpcEventSink<TEvent>): void {
    if (!channel || this.channel === channel) {
      this.channel = null;
    }
  }

  async send(event: TEvent): Promise<void> {
    this.enqueue(event);
    await this.flush();
  }

  getBufferedEventCount(): number {
    return this.bufferedEvents.length;
  }

  getDroppedEventCount(): number {
    return this.droppedEvents;
  }

  private enqueue(event: TEvent): void {
    if (this.bufferedEvents.length >= this.maxBufferedEvents) {
      this.droppedEvents += 1;
      if (this.droppedEvents === 1 || this.droppedEvents % 100 === 0) {
        this.logger.warn(
          `Dropping gRPC ${this.eventName} because outbound buffer reached ${this.maxBufferedEvents} entries ` +
            `(dropped=${this.droppedEvents}).`,
        );
      }
      return;
    }

    this.bufferedEvents.push(event);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }

    this.flushing = true;
    try {
      while (this.channel && this.bufferedEvents.length > 0) {
        const nextEvent = this.bufferedEvents[0];
        try {
          await this.channel.send(nextEvent);
          this.bufferedEvents.shift();
        } catch (error: unknown) {
          this.logger.warn(`Failed to send buffered gRPC ${this.eventName}: ${toErrorMessage(error)}`);
          this.channel = null;
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export type ClientMessageSink = GrpcEventSink<ClientMessage>;

export class BufferedClientMessageSender extends BufferedGrpcEventSender<ClientMessage> {
  constructor(options: Omit<BufferedGrpcEventSenderOptions, "eventName">) {
    super({
      ...options,
      eventName: "client message",
    });
  }

  getBufferedMessageCount(): number {
    return this.getBufferedEventCount();
  }

  getDroppedMessageCount(): number {
    return this.getDroppedEventCount();
  }
}
