// Classic promise-queue semaphore with runtime resize (for the global worker concurrency cap).
// acquire() resolves with a release function; calling it (idempotently) frees the permit and
// hands it to the next FIFO waiter.
export class Semaphore {
  private permits: number;
  private maxPermits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
    this.maxPermits = permits;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.permits--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.doRelease();
        });
      };
      if (this.permits > 0) grant();
      else this.waiters.push(grant);
    });
  }

  private doRelease() {
    this.permits++;
    if (this.permits > 0 && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next(); // re-decrements permits and resolves the waiter
    }
  }

  get available(): number {
    return this.permits;
  }

  // Adjust the permit cap at runtime; releases drained to waiters when increasing.
  resize(n: number): void {
    this.permits += n - this.maxPermits;
    this.maxPermits = n;
    while (this.permits > 0 && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }
}
