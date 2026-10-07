import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pythonExecutable = process.platform === "win32"
  ? resolve(repositoryRoot, ".venv/Scripts/python.exe")
  : resolve(repositoryRoot, ".venv/bin/python");
const testProcess = spawn(pythonExecutable, ["-m", "unittest", "discover", "-s", "services/ingestion/tests"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});

testProcess.once("error", (executionError) => {
  process.stderr.write(`Não foi possível iniciar os testes da API: ${executionError.message}\n`);
  process.exitCode = 1;
});

testProcess.once("exit", (exitCode) => {
  process.exitCode = exitCode ?? 1;
});
