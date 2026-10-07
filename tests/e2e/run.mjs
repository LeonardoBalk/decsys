import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const frontendUrl = "http://127.0.0.1:3100";
const ingestionUrl = "http://127.0.0.1:8100";
const runningServers = [];

function isPortAvailable(port) {
  return new Promise((resolveAvailability, rejectAvailability) => {
    const probeServer = createServer();
    probeServer.once("error", rejectAvailability);
    probeServer.listen(port, "127.0.0.1", () => probeServer.close(() => resolveAvailability()));
  });
}

function startServer(serverName, executablePath, argumentsList, environment) {
  const serverProcess = spawn(executablePath, argumentsList, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (output) => process.stdout.write(`[${serverName}] ${output}`));
  serverProcess.stderr.on("data", (output) => process.stderr.write(`[${serverName}] ${output}`));
  runningServers.push(serverProcess);
  return serverProcess;
}

async function waitForServer(serverName, serverProcess, serverUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`${serverName} encerrou com código ${serverProcess.exitCode} antes de ficar pronto.`);
    try {
      const response = await fetch(serverUrl);
      if (response.ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error(`${serverName} não respondeu em ${timeoutMs / 1000} segundos.`);
}

async function stopServer(serverProcess) {
  if (serverProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(serverProcess.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      serverProcess.kill();
    }
  } else {
    serverProcess.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolveExit) => serverProcess.once("exit", resolveExit)), delay(5000)]);
}

async function runPlaywright() {
  const playwrightCli = resolve(testDirectory, "node_modules/@playwright/test/cli.js");
  const playwrightConfig = resolve(testDirectory, "playwright.config.ts");
  const playwrightProcess = spawn(process.execPath, [playwrightCli, "test", "--config", playwrightConfig], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  return await new Promise((resolveExit, rejectExit) => {
    playwrightProcess.once("error", rejectExit);
    playwrightProcess.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
}

let exitCode = 1;

try {
  await Promise.all([isPortAvailable(3100), isPortAvailable(8100)]);
  const pythonExecutable = process.platform === "win32"
    ? resolve(repositoryRoot, ".venv/Scripts/python.exe")
    : resolve(repositoryRoot, ".venv/bin/python");
  const ingestionProcess = startServer("Ingestion", pythonExecutable, ["-m", "uvicorn", "services.ingestion.app.main:app", "--host", "127.0.0.1", "--port", "8100"], {
    SUPABASE_URL: "http://127.0.0.1:8199",
    SUPABASE_SERVICE_ROLE_KEY: "playwright-isolated-test-key",
    AI_PROVIDER: "disabled",
    GEMINI_API_KEY: "",
    OPENAI_API_KEY: "",
  });
  await waitForServer("Ingestion", ingestionProcess, `${ingestionUrl}/docs`, 60_000);

  const nextExecutable = resolve(repositoryRoot, "node_modules/next/dist/bin/next");
  const frontendProcess = startServer("Next", process.execPath, [nextExecutable, "dev", "--hostname", "127.0.0.1", "--port", "3100"], {
    INGESTION_API_URL: ingestionUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  });
  await waitForServer("Next", frontendProcess, frontendUrl, 180_000);
  exitCode = await runPlaywright();
} catch (testRunError) {
  process.stderr.write(`${testRunError instanceof Error ? testRunError.message : String(testRunError)}\n`);
} finally {
  await Promise.all(runningServers.reverse().map(stopServer));
}

process.exitCode = exitCode;
