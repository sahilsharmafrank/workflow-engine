import axios from "axios";
import { BaseStep, WorkflowStatus } from "@wfe/sdk";
import type { RunStepResponse, StepContext } from "@wfe/sdk";

/** Calls wttr.in's JSON weather endpoint for a city. Ignores WFE_HTTP_ALLOW_PRIVATE_HOSTS
 * and core.http's SSRF guard entirely — this step only ever targets a hardcoded
 * public host, it doesn't take a URL from the definition. */
export class GetWeatherStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const { city } = ctx.inputs as { city: string };
    if (typeof city !== "string" || city.trim().length === 0) {
      throw new Error("demo.getWeather requires a non-empty string input named city");
    }

    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    let response;
    try {
      response = await axios.get(url, {
        headers: { Accept: "application/json" },
        timeout: 10_000,
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        throw new Error(
          `demo.getWeather: wttr.in returned HTTP ${err.response.status} for city "${city}"`,
        );
      }
      throw err;
    }

    // wttr.in sends `content-type: text/plain` even for its JSON endpoint, but
    // axios's default transformResponse tries JSON.parse on any string body
    // regardless of content-type, so `response.data` is already an object.
    const body = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

    ctx.step.outputs = { status: response.status, body };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
