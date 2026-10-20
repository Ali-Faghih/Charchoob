import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const venvWin = ".venv\\Scripts\\python.exe"
const venvUnix = ".venv/bin/python"
const python = existsSync(venvWin) ? venvWin : existsSync(venvUnix) ? venvUnix : "python"

const child = spawn(python, ["-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"], {
  stdio: "inherit",
})
child.on("exit", (code) => process.exit(code ?? 1))
process.on("SIGINT", () => { child.kill(); process.exit() })
process.on("SIGTERM", () => { child.kill(); process.exit() })
