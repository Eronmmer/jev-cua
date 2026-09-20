import { assertSupportedNodeRuntime } from "../runtime/node-version.js";
import {
  DEFAULT_BENCHMARK_OPTIONS,
  parseBenchmarkArguments,
  runBenchmark,
} from "./harness.js";

assertSupportedNodeRuntime();

const HELP = `Usage: npm run benchmark -- [options]

Options:
  --arm jev|deterministic|both  Arm to run (default: ${DEFAULT_BENCHMARK_OPTIONS.arm})
  --pairs N                    Measured pairs/runs per arm (default: ${DEFAULT_BENCHMARK_OPTIONS.pairs})
  --warmup-pairs N             Warm-up pairs/runs per arm (default: ${DEFAULT_BENCHMARK_OPTIONS.warmupPairs})
  --seed VALUE                 Reproducible AB/BA seed (default: ${DEFAULT_BENCHMARK_OPTIONS.seed})
  --help                       Show this help
`;

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help")) {
    if (arguments_.length !== 1) throw new Error("--help cannot be combined");
    process.stdout.write(HELP);
    return;
  }
  const options = parseBenchmarkArguments(arguments_);
  process.stdout.write(
    `Starting ${options.arm} benchmark: ${options.warmupPairs} warm-up and ${options.pairs} measured pair(s), seed ${options.seed}.\n`,
  );
  const abort = new AbortController();
  const requestStop = () => abort.abort();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const { report, reportPath } = await runBenchmark(
    options,
    (progress) => {
      const trial = progress.trial;
      process.stdout.write(
        `[${progress.completed}/${progress.total}] ${trial.phase} pair ${trial.pairIndex + 1} ${trial.arm}: ${trial.outcome} in ${trial.latencyMs} ms\n`,
      );
    },
    abort.signal,
  ).finally(() => {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  });
  process.stdout.write(
    `${report.status === "complete" ? "Completed" : "Stopped"}. Report: ${reportPath}\n`,
  );
  if (!report.measurementsValid) {
    process.stderr.write(
      `Measurements invalid: ${report.measurementInvalidReasons.join(", ") || "terminal validation did not complete"}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report.measuredSummary, null, 2)}\n`);
  if (report.status !== "complete" || !report.measurementsValid) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Benchmark failed: ${error instanceof Error ? error.message : "UnknownError"}\n`,
  );
  process.exitCode = 1;
});
