import { StepRegistry } from "@wfe/core";

// Shared with WorkflowRun.status and StepRun.status below — both persist the
// same @wfe/sdk WorkflowStatus enum (see packages/sdk/src/status.ts and the
// note on StepRun.status in packages/core/src/entities/step-run.ts).
const WORKFLOW_STATUS_VALUES = [
  "new", "starting", "running", "waiting", "complete", "failed",
  "cancelling", "cancelled", "paused", "skipped",
];

export function buildOpenApiSpec(registry: StepRegistry): Record<string, unknown> {
  const stepTypes = registry.list().map((r) => ({
    type: r.type, version: r.version, description: r.description ?? "",
  }));

  return {
    openapi: "3.0.3",
    info: {
      title: "Workflow Engine API",
      version: "0.1.0",
      description: "REST API for the standalone workflow engine.",
    },
    paths: {
      "/api/v1/health": {
        get: {
          summary: "Health check",
          operationId: "getHealth",
          tags: ["System"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" } } } } } } },
        },
      },
      "/api/v1/version": {
        get: {
          summary: "Version info",
          operationId: "getVersion",
          tags: ["System"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", properties: { version: { type: "string" } } } } } } },
        },
      },
      "/api/v1/definitions": {
        get: {
          summary: "List workflow definitions",
          operationId: "listDefinitions",
          tags: ["Definitions"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["draft", "published", "archived"] } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "Paginated list of definitions", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinitionList" } } } } },
        },
        post: {
          summary: "Create a workflow definition",
          operationId: "createDefinition",
          tags: ["Definitions"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, definition: { type: "object" } }, required: ["name", "version", "definition"] } } } },
          responses: { 201: { description: "Created" }, 400: { description: "Validation error" } },
        },
      },
      "/api/v1/definitions/{id}": {
        get: {
          summary: "Get a workflow definition",
          operationId: "getDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Definition", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinition" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
        put: {
          summary: "Update a workflow definition",
          operationId: "updateDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" }, 404: { description: "Not found" } },
        },
      },
      "/api/v1/definitions/{id}/publish": {
        post: {
          summary: "Publish (or archive) a definition",
          operationId: "publishDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Status transitioned" }, 400: { description: "Invalid transition" } },
        },
      },
      "/api/v1/definitions/import": {
        post: {
          summary: "Bulk import definitions",
          operationId: "importDefinitions",
          tags: ["Definitions"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } },
          responses: { 201: { description: "Imported", content: { "application/json": { schema: { type: "object", properties: { imported: { type: "integer" } }, required: ["imported"] } } } } },
        },
      },
      "/api/v1/runs": {
        post: {
          summary: "Start a workflow run",
          operationId: "createRun",
          tags: ["Runs"],
          parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, inputs: { type: "object" } }, required: ["name", "version"] } } } },
          responses: { 201: { description: "Run started" }, 200: { description: "Idempotent replay" } },
        },
        get: {
          summary: "List workflow runs",
          operationId: "listRuns",
          tags: ["Runs"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "Paginated list of runs", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowRunList" } } } } },
        },
      },
      "/api/v1/runs/{id}": {
        get: {
          summary: "Get a workflow run with all step runs",
          operationId: "getRun",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Run with steps", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowRun" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
      "/api/v1/runs/search": {
        post: {
          summary: "Deep jsonb search across runs",
          operationId: "searchRuns",
          tags: ["Runs"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { filter: { type: "object" } } } } } },
          responses: { 200: { description: "Matching runs", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/WorkflowRun" } } } } } },
        },
      },
      "/api/v1/runs/by-ids": {
        post: {
          summary: "Get multiple runs by ID",
          operationId: "getRunsByIds",
          tags: ["Runs"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" } } } } } } },
          responses: { 200: { description: "Runs" } },
        },
      },
      "/api/v1/runs/{id}/cancel": {
        put: {
          summary: "Cancel a workflow run",
          operationId: "cancelRun",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Cancelled", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowRun" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
      "/api/v1/runs/{id}/restart/step/{n}": {
        put: {
          summary: "Restart a run from a specific step",
          operationId: "restartFromStep",
          tags: ["Runs"],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "n", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: {
            200: { description: "Restarted", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowRun" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
      "/api/v1/runs/{id}/callback": {
        put: {
          summary: "External worker callback",
          operationId: "callback",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { stepNumber: { type: "integer" }, body: { type: "object" } }, required: ["stepNumber"] } } } },
          responses: { 200: { description: "Resumed" } },
        },
      },
      "/api/v1/runs/{id}/inputs": {
        put: {
          summary: "Update run inputs",
          operationId: "updateRunInputs",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { inputs: { type: "object" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/steps/next": {
        get: {
          summary: "Claim next external task step",
          operationId: "claimNextStep",
          tags: ["Steps"],
          parameters: [{ name: "service", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Step claimed" }, 204: { description: "No step available" } },
        },
      },
      "/api/v1/steps/search": {
        post: {
          summary: "Search step runs",
          operationId: "searchSteps",
          tags: ["Steps"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Matching steps" } },
        },
      },
      "/api/v1/steps/{id}/state": {
        put: {
          summary: "Update step state",
          operationId: "updateStepState",
          tags: ["Steps"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { state: { type: "object" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/steps/{id}/inputs-outputs": {
        put: {
          summary: "Update step inputs and outputs",
          operationId: "updateStepInputsOutputs",
          tags: ["Steps"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/steps/{id}/priority": {
        put: {
          summary: "Update step priority",
          operationId: "updateStepPriority",
          tags: ["Steps"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { priority: { type: "integer" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/step-types": {
        get: {
          summary: "List registered step types",
          operationId: "listStepTypes",
          tags: ["Steps"],
          responses: { 200: { description: "Step types", content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { type: { type: "string" }, version: { type: "string" }, description: { type: "string" } } } } } } } },
        },
      },
      "/api/v1/steps/dry-run": {
        post: {
          summary: "Evaluate capture expressions against sample state",
          operationId: "dryRunStep",
          tags: ["Steps"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { expressions: { type: "array" }, state: { type: "object" }, config: { type: "object" }, body: {} } } } } },
          responses: { 200: { description: "Evaluation result" } },
        },
      },
      "/api/v1/batch-jobs": {
        post: {
          summary: "Create a batch job (fan out a workflow over N inputs)",
          operationId: "createBatchJob",
          tags: ["Batch Jobs"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object",
            properties: {
              name: { type: "string" }, definitionName: { type: "string" },
              definitionVersion: { type: "string" },
              inputs: { type: "array", items: { type: "object" } },
            },
            required: ["name", "definitionName", "definitionVersion", "inputs"],
          } } } },
          responses: { 201: { description: "Batch created and fan-out started" }, 400: { description: "Validation error" } },
        },
        get: {
          summary: "List batch jobs",
          operationId: "listBatchJobs",
          tags: ["Batch Jobs"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: {
            // BatchJobRepository.list() (packages/core/src/repositories/batch-job-repository.ts)
            // returns a plain array, not a { rows, total } envelope — unlike
            // listRuns/listDefinitions. Documented to match the real response,
            // not the envelope pattern used elsewhere.
            200: { description: "Batch jobs", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/BatchJob" } } } } },
          },
        },
      },
      "/api/v1/batch-jobs/{id}": {
        get: {
          summary: "Get batch job with progress",
          operationId: "getBatchJob",
          tags: ["Batch Jobs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Batch job with progress", content: { "application/json": { schema: { $ref: "#/components/schemas/BatchJobWithProgress" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
      "/api/v1/batch-jobs/{id}/cancel": {
        put: {
          summary: "Cancel a batch job and all its runs",
          operationId: "cancelBatchJob",
          tags: ["Batch Jobs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            // No `progress` field here: the controller returns the plain
            // BatchJobRepository.update() result, unlike getBatchJob which
            // attaches computeProgress() separately.
            200: { description: "Cancelled", content: { "application/json": { schema: { $ref: "#/components/schemas/BatchJob" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
      "/api/v1/filter-configuration": {
        get: {
          summary: "Filter metadata for the UI",
          operationId: "getFilterConfiguration",
          tags: ["System"],
          responses: { 200: { description: "Filter descriptors for definitions, runs, and steps", content: { "application/json": { schema: { $ref: "#/components/schemas/FilterConfiguration" } } } } },
        },
      },
    },
    components: {
      schemas: {
        StepType: {
          type: "object",
          properties: {
            type: { type: "string" }, version: { type: "string" }, description: { type: "string" },
          },
        },
        // Arbitrary caller/step-defined JSON — WorkflowRun/StepRun's
        // inputs/outputs/state (WorkflowParameters in @wfe/sdk). Deliberately
        // left open rather than given invented structure.
        WorkflowParameters: {
          type: "object",
          additionalProperties: true,
        },
        StepProgress: {
          type: "object",
          properties: {
            units: { type: "string", nullable: true },
            totalExpected: { type: "number", nullable: true },
            currentProgress: { type: "number", nullable: true },
          },
        },
        // Matches StepRunLike (@wfe/sdk) plus createdDate/updatedDate, which
        // TypeORM's @CreateDateColumn/@UpdateDateColumn add to every row and
        // which res.json(...) serializes like any other own property. Fields
        // present on the entity but not needed by the UI (runId, tenantId,
        // targetAgent, priority, remoteTaskStatus, originalRunId) are left
        // undeclared; the schema does not claim these are the only fields.
        StepRun: {
          type: "object",
          properties: {
            id: { type: "integer" },
            stepNumber: { type: "integer" },
            stepName: { type: "string" },
            stepType: { type: "string" },
            status: { type: "string", enum: WORKFLOW_STATUS_VALUES },
            message: { type: "string", nullable: true },
            inputs: { $ref: "#/components/schemas/WorkflowParameters" },
            outputs: { $ref: "#/components/schemas/WorkflowParameters" },
            state: { $ref: "#/components/schemas/WorkflowParameters" },
            progress: { $ref: "#/components/schemas/StepProgress" },
            externalServiceName: { type: "string", nullable: true },
            lastStepAction: { type: "string", format: "date-time", nullable: true },
            createdDate: { type: "string", format: "date-time" },
            updatedDate: { type: "string", format: "date-time" },
          },
          required: ["id", "stepNumber", "stepName", "stepType", "status", "inputs", "outputs", "state"],
        },
        // Matches WorkflowRunLike (@wfe/sdk) plus the persistence-only fields
        // (revision, depth, tenantId, createdDate/updatedDate) that are real,
        // present-on-every-response fields of the WorkflowRun entity. Uses
        // the transient inputs/outputs/state names, not the inputsJson/
        // outputsJson/stateJson columns also present on the wire — see the
        // @AfterLoad/@BeforeInsert pair in workflow-run.ts.
        WorkflowRun: {
          type: "object",
          properties: {
            id: { type: "integer" },
            tenantId: { type: "string" },
            definitionId: { type: "integer", nullable: true },
            parentRunId: { type: "integer", nullable: true },
            depth: { type: "integer" },
            name: { type: "string" },
            version: { type: "string" },
            revision: { type: "integer" },
            currentStep: { type: "integer" },
            status: { type: "string", enum: WORKFLOW_STATUS_VALUES },
            inputs: { $ref: "#/components/schemas/WorkflowParameters" },
            outputs: { $ref: "#/components/schemas/WorkflowParameters" },
            state: { $ref: "#/components/schemas/WorkflowParameters" },
            stepRuns: { type: "array", items: { $ref: "#/components/schemas/StepRun" } },
            createdDate: { type: "string", format: "date-time" },
            updatedDate: { type: "string", format: "date-time" },
          },
          required: ["id", "tenantId", "name", "version", "currentStep", "status", "inputs", "outputs", "state"],
        },
        WorkflowRunList: {
          type: "object",
          properties: {
            rows: { type: "array", items: { $ref: "#/components/schemas/WorkflowRun" } },
            total: { type: "integer" },
          },
          required: ["rows", "total"],
        },
        // `definition` is WorkflowDefinitionBody (@wfe/sdk) — a steps document
        // whose own fields (capture expressions, pre-flight checks, ...) are
        // themselves open-ended, so it is left as a permissive object rather
        // than reproduced field-by-field here.
        WorkflowDefinition: {
          type: "object",
          properties: {
            id: { type: "integer" },
            tenantId: { type: "string" },
            name: { type: "string" },
            version: { type: "string" },
            status: { type: "string", enum: ["draft", "published", "archived"] },
            definition: { type: "object", additionalProperties: true },
            lastUpdateHistory: { type: "object", nullable: true, additionalProperties: true },
            createdDate: { type: "string", format: "date-time" },
            updatedDate: { type: "string", format: "date-time" },
          },
          required: ["id", "tenantId", "name", "version", "status", "definition"],
        },
        WorkflowDefinitionList: {
          type: "object",
          properties: {
            rows: { type: "array", items: { $ref: "#/components/schemas/WorkflowDefinition" } },
            total: { type: "integer" },
          },
          required: ["rows", "total"],
        },
        // `status` is a plain `string` column (packages/core/src/entities/batch-job.ts),
        // not a closed set in the implementation — values observed in
        // controllers are pending/running/failed/cancelled, and "complete" is
        // read by computeProgress()'s aggregation but no write path in this
        // codebase currently sets it. Left as an unconstrained string rather
        // than an enum that could omit a real value.
        BatchJob: {
          type: "object",
          properties: {
            id: { type: "integer" },
            tenantId: { type: "string" },
            name: { type: "string" },
            definitionName: { type: "string" },
            definitionVersion: { type: "string" },
            status: { type: "string" },
            totalCount: { type: "integer" },
            inputs: { type: "array", items: { type: "object", additionalProperties: true } },
            runIds: { type: "array", items: { type: "integer" } },
            message: { type: "string", nullable: true },
            createdDate: { type: "string", format: "date-time" },
            updatedDate: { type: "string", format: "date-time" },
          },
          required: ["id", "tenantId", "name", "definitionName", "definitionVersion", "status", "totalCount", "inputs", "runIds"],
        },
        BatchJobProgress: {
          type: "object",
          properties: {
            completedCount: { type: "integer" },
            failedCount: { type: "integer" },
            runningCount: { type: "integer" },
          },
          required: ["completedCount", "failedCount", "runningCount"],
        },
        // GET /batch-jobs/{id} only: `{ ...job, progress }` from the controller.
        BatchJobWithProgress: {
          allOf: [
            { $ref: "#/components/schemas/BatchJob" },
            {
              type: "object",
              properties: { progress: { $ref: "#/components/schemas/BatchJobProgress" } },
              required: ["progress"],
            },
          ],
        },
        FilterField: {
          type: "object",
          properties: {
            field: { type: "string" },
            type: { type: "string", enum: ["enum", "text", "dateRange"] },
            values: { type: "array", items: { type: "string" } },
          },
          required: ["field", "type"],
        },
        FilterConfiguration: {
          type: "object",
          properties: {
            definitions: { type: "array", items: { $ref: "#/components/schemas/FilterField" } },
            runs: { type: "array", items: { $ref: "#/components/schemas/FilterField" } },
            steps: { type: "array", items: { $ref: "#/components/schemas/FilterField" } },
          },
          required: ["definitions", "runs", "steps"],
        },
        // Matches errorHandler() (packages/server/src/middleware/error-handler.ts):
        // WfeError responses carry { code, message, details? }; details is
        // `unknown` on WfeError and genuinely varies by error, so it is left
        // unconstrained rather than typed.
        ErrorEnvelope: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: {},
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
    "x-step-types": stepTypes,
  };
}
