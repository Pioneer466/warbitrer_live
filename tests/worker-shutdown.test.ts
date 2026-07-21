import {
  runCoordinatedWorkerTasks,
  runWatchdogBoundTask,
  shutdownWorkerResources,
  WorkerShutdownCoordinator,
  WorkerTaskTimeoutError,
} from "@/worker/shutdown";

describe("worker shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes every inter-tick wait exactly once when shutdown is requested", async () => {
    vi.useFakeTimers();
    const coordinator = new WorkerShutdownCoordinator();
    const first = coordinator.wait(60_000);
    const second = coordinator.wait(60_000);

    expect(coordinator.request()).toBe(true);
    expect(coordinator.request()).toBe(false);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(coordinator.isRequested).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(coordinator.wait(60_000)).resolves.toBeUndefined();
  });

  it("closes storage only after market data and notification work have drained", async () => {
    const marketData = deferred<void>();
    const notifications = deferred<void>();
    const closeStorage = vi.fn().mockResolvedValue(undefined);
    const shutdown = shutdownWorkerResources({
      closeMarketData: vi.fn().mockReturnValue(marketData.promise),
      waitForNotifications: vi.fn().mockReturnValue(notifications.promise),
      closeStorage,
    });

    await Promise.resolve();
    expect(closeStorage).not.toHaveBeenCalled();
    marketData.resolve();
    await Promise.resolve();
    expect(closeStorage).not.toHaveBeenCalled();
    notifications.resolve();

    await expect(shutdown).resolves.toBeUndefined();
    expect(closeStorage).toHaveBeenCalledTimes(1);
  });

  it("stops and awaits sibling loops when one coordinated task fails", async () => {
    vi.useFakeTimers();
    const coordinator = new WorkerShutdownCoordinator();
    const failure = new Error("executor watchdog expired");
    const siblingFinished = vi.fn();

    const tasks = runCoordinatedWorkerTasks(
      [
        async () => {
          await coordinator.wait(60_000);
          siblingFinished();
        },
        async () => {
          throw failure;
        },
      ],
      () => {
        coordinator.request();
      },
    );

    await expect(tasks).rejects.toBe(failure);
    expect(siblingFinished).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still closes storage and reports all cleanup failures", async () => {
    const marketFailure = new Error("market close failed");
    const storageFailure = new Error("pool close failed");

    await expect(
      shutdownWorkerResources({
        closeMarketData: vi.fn().mockImplementation(() => {
          throw marketFailure;
        }),
        waitForNotifications: vi.fn().mockResolvedValue(undefined),
        closeStorage: vi.fn().mockRejectedValue(storageFailure),
      }),
    ).rejects.toMatchObject({
      errors: [marketFailure, storageFailure],
    });
  });

  it("does not abandon a timed-out task while it may still own resources", async () => {
    vi.useFakeTimers();
    const task = deferred<string>();
    const onTimeout = vi.fn();
    const result = runWatchdogBoundTask({
      name: "reconcile",
      timeoutMs: 1_000,
      task: () => task.promise,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).toHaveBeenCalledWith(expect.any(WorkerTaskTimeoutError));

    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    task.resolve("finished");
    await expect(result).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves both timeout and eventual task failure", async () => {
    vi.useFakeTimers();
    const task = deferred<void>();
    const failure = new Error("database write failed");
    const result = runWatchdogBoundTask({
      name: "executor",
      timeoutMs: 1_000,
      task: () => task.promise,
      onTimeout: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    task.reject(failure);

    await expect(result).rejects.toMatchObject({
      errors: [expect.any(WorkerTaskTimeoutError), failure],
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
