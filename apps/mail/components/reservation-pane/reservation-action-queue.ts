type Priority = 'staff' | 'background';
type Action = { run: () => Promise<void>; resolve: () => void; reject: (failure: unknown) => void };

/** One complete action at a time; queued staff actions precede queued warmups. */
export class ReservationActionQueue {
  private readonly staff: Action[] = [];
  private readonly background: Action[] = [];
  private running = false;

  enqueue(run: Action['run'], priority: Priority = 'staff'): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      this[priority].push({ run, resolve, reject });
    });
    void this.drain();
    return result;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let action: Action | undefined;
      while ((action = this.staff.shift() ?? this.background.shift())) {
        try { await action.run(); action.resolve(); }
        catch (failure) { action.reject(failure); }
      }
    } finally { this.running = false; }
  }
}
