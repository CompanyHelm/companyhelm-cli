type Waiter<T> = {
  resolve: (value: T | null) => void;
  reject: (reason?: unknown) => void;
};

export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private error: Error | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed || this.error) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  async pop(): Promise<T | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.error) {
      throw this.error;
    }
    if (this.closed) {
      return null;
    }

    return new Promise<T | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  fail(error: Error): void {
    if (this.closed || this.error) {
      return;
    }
    this.error = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  close(): void {
    if (this.closed || this.error) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve(null);
    }
  }
}
