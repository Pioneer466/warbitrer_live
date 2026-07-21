export type WorkerShutdownDependencies = {
  closeMarketData: () => Promise<void>;
  waitForNotifications: () => Promise<void>;
  closeStorage: () => Promise<void>;
};

export class WorkerTaskTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTaskTimeoutError";
  }
}

export class WorkerShutdownCoordinator {
  private requested = false;
  private waiters = new Set<() => void>();

  get isRequested() {
    return this.requested;
  }

  request() {
    if (this.requested) {
      return false;
    }

    this.requested = true;
    for (const wake of [...this.waiters]) {
      wake();
    }
    return true;
  }

  wait(ms: number) {
    if (this.requested || ms <= 0) {
      return Promise.resolve();
    }

    const waiters = this.waiters;
    return new Promise<void>((resolve) => {
      const timeoutHandle = setTimeout(done, ms);
      waiters.add(done);

      function done() {
        if (!waiters.delete(done)) {
          return;
        }
        clearTimeout(timeoutHandle);
        resolve();
      }
    });
  }
}

export async function runCoordinatedWorkerTasks(
  tasks: Array<() => Promise<void>>,
  onFailure: (error: unknown) => void,
) {
  let failed = false;
  let firstFailure: unknown;
  await Promise.all(
    tasks.map(async (task) => {
      try {
        await task();
      } catch (error) {
        if (!failed) {
          firstFailure = error;
        }
        failed = true;
        onFailure(error);
      }
    }),
  );

  if (failed) {
    throw firstFailure;
  }
}

export async function runWatchdogBoundTask<T>({
  name,
  timeoutMs,
  task,
  onTimeout,
}: {
  name: string;
  timeoutMs: number;
  task: () => Promise<T> | T;
  onTimeout: (error: WorkerTaskTimeoutError) => void;
}) {
  const taskPromise = Promise.resolve().then(task);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutError = new WorkerTaskTimeoutError(`${name} loop timed out after ${timeoutMs}ms`);
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      onTimeout(timeoutError);
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const taskResult = taskPromise.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  const first = await Promise.race([taskResult, timeoutPromise]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  if (first.kind === "resolved") {
    return first.value;
  }
  if (first.kind === "rejected") {
    throw first.error;
  }

  // A timed-out task cannot be abandoned safely: it may still own venue or
  // database work. Let systemd enforce the outer shutdown deadline if needed.
  const final = await taskResult;
  if (final.kind === "rejected") {
    throw new AggregateError([timeoutError, final.error], `${name} timed out and then failed`);
  }
  throw timeoutError;
}

export async function shutdownWorkerResources(dependencies: WorkerShutdownDependencies) {
  const failures: unknown[] = [];
  const upstreamResults = await Promise.allSettled([
    Promise.resolve().then(dependencies.closeMarketData),
    Promise.resolve().then(dependencies.waitForNotifications),
  ]);

  for (const result of upstreamResults) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }

  try {
    await dependencies.closeStorage();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Worker resource shutdown failed");
  }
}
