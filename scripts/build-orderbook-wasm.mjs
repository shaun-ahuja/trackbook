import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outDir = resolve(repoRoot, "public/wasm/orderbook");
const tmpDir = resolve(repoRoot, ".tmp/orderbook-wasm");
const emCacheDir = resolve(repoRoot, ".tmp/emscripten-cache");

function run(cmd, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        EM_CACHE: emCacheDir,
      },
    });
    child.on("error", (error) => {
      rejectRun(error);
    });
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
  try {
    await mkdir(emCacheDir, { recursive: true });
    await run("em++", ["--version"], repoRoot);
  } catch {
    throw new Error("Emscripten `em++` is required and must be runnable with a writable cache directory.");
  }

  await mkdir(tmpDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const tmpBase = join(tmpDir, "orderbook");
  const exportList = [
    "_tb_version",
    "_tb_alloc_bytes",
    "_tb_free_bytes",
    "_tb_engine_create",
    "_tb_engine_reset",
    "_tb_engine_destroy",
    "_tb_engine_exec",
  ];

  await run(
    "em++",
    [
      "-std=c++20",
      "-O3",
      "--no-entry",
      "-sWASM=1",
      "-sALLOW_MEMORY_GROWTH=1",
      "-sFILESYSTEM=0",
      "-sENVIRONMENT=web,node",
      "-sMODULARIZE=1",
      "-sEXPORT_ES6=1",
      "-sEXPORT_ALL=1",
      `-sEXPORTED_FUNCTIONS=${JSON.stringify(exportList)}`,
      resolve(repoRoot, "cpp/engine/MatchingEngine.cpp"),
      resolve(repoRoot, "cpp/engine/exports.cpp"),
      "-o",
      `${tmpBase}.mjs`,
    ],
    repoRoot,
  );

  await rename(`${tmpBase}.mjs`, join(outDir, "orderbook.mjs"));
  await rename(`${tmpBase}.wasm`, join(outDir, "orderbook.wasm"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
