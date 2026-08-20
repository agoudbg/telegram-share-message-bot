/* global clearTimeout, console, process, setTimeout */

import { spawn } from 'node:child_process';

const FORCE_SHUTDOWN_MS = 10_000;
const serviceDefinitions = [
  ['server', 'apps/server/dist/main.js'],
  ['bot', 'apps/bot/dist/main.js'],
];

const services = serviceDefinitions.map(([name, entrypoint]) => ({
  name,
  process: spawn(process.execPath, [entrypoint], {
    env: process.env,
    stdio: 'inherit',
  }),
}));

let remainingServices = services.length;
let isStopping = false;
let supervisorExitCode = 0;
let forceShutdownTimer;

for (const service of services) {
  service.process.once('error', (error) => {
    console.error(`[supervisor] Failed to start ${service.name}:`, error);
    beginShutdown(1, 'SIGTERM');
  });

  service.process.once('close', (code, signal) => {
    remainingServices -= 1;
    if (!isStopping) {
      console.error(
        `[supervisor] ${service.name} exited unexpectedly (${signal ?? `code ${code ?? 1}`}).`,
      );
      beginShutdown(code === 0 ? 1 : (code ?? 1), 'SIGTERM');
    }

    if (remainingServices === 0) finishShutdown();
  });
}

process.once('SIGINT', () => beginShutdown(0, 'SIGINT'));
process.once('SIGTERM', () => beginShutdown(0, 'SIGTERM'));

function beginShutdown(exitCode, signal) {
  if (isStopping) return;

  isStopping = true;
  supervisorExitCode = exitCode;
  for (const service of services) {
    if (service.process.exitCode === null && service.process.signalCode === null) {
      service.process.kill(signal);
    }
  }

  forceShutdownTimer = setTimeout(() => {
    for (const service of services) {
      if (service.process.exitCode === null && service.process.signalCode === null) {
        service.process.kill('SIGKILL');
      }
    }
  }, FORCE_SHUTDOWN_MS);
  forceShutdownTimer.unref();
}

function finishShutdown() {
  if (forceShutdownTimer) clearTimeout(forceShutdownTimer);
  process.exitCode = supervisorExitCode;
}
