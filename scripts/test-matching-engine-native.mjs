import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const tmpDir = resolve(repoRoot, ".tmp/native-engine-tests");
const binaryPath = resolve(tmpDir, "matching_engine_smoke");

function run(cmd, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${cmd} exited with code ${code ?? -1}`));
    });
  });
}

async function main() {
  await mkdir(tmpDir, { recursive: true });

  await run(
    "clang++",
    [
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-pedantic",
      "-O2",
      resolve(repoRoot, "cpp/engine/MatchingEngine.cpp"),
      resolve(repoRoot, "cpp/engine/tests/matching_engine_smoke.cpp"),
      "-o",
      binaryPath,
    ],
    repoRoot,
  );

  await run(binaryPath, [], repoRoot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
