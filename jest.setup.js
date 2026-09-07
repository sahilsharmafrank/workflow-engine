// Keep test output readable: pino defaults to "info", which floods the
// console with structured logs from every WorkflowManager/RunExecutor call
// in the integration tests. Runs before each test file is required, so it
// takes effect before logging.ts's module-level pino(...) call reads it.
process.env.WFE_LOG_LEVEL = process.env.WFE_LOG_LEVEL || "silent";
