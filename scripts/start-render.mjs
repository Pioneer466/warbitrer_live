import { spawn } from "node:child_process";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npmCmd, ["run", "start"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(npmCmd, ["run", "start:worker"], {
    stdio: "inherit",
    env: process.env,
  }),
];

let shuttingDown = false;

function terminate(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    terminate();

    if (signal) {
      process.exitCode = 1;
      return;
    }

    process.exitCode = code ?? 1;
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => terminate(signal));
}
