import { BaseStep, WorkflowStatus } from "@wfe/sdk";
import type { RunStepResponse, StepContext } from "@wfe/sdk";

interface WttrHour {
  time: string;
  weatherDesc?: { value: string }[];
  chanceofrain?: string;
  humidity?: string;
}

interface WttrDay {
  date: string;
  maxtempC: string;
  mintempC: string;
  avgtempC: string;
  hourly?: WttrHour[];
}

/**
 * Picks the forecast day matching the requested date (falling back to the
 * first available day, flagged via `dateMatched`) and the closest-to-noon
 * hourly reading, then reshapes them into a flat summary.
 */
export class ParseWeatherStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const { body, city, date } = ctx.inputs as { body: { weather?: WttrDay[] }; city: string; date?: string };

    const days = body?.weather ?? [];
    const day = days.find((d) => d.date === date) ?? days[0] ?? null;
    const hourly = day?.hourly ?? [];
    const midday =
      hourly.find((h) => h.time === "1200") ?? hourly[Math.floor(hourly.length / 2)] ?? undefined;

    ctx.step.outputs = {
      weatherSummary: {
        city,
        date: day?.date ?? null,
        requestedDate: date ?? null,
        dateMatched: day?.date === date,
        maxTempC: day ? Number(day.maxtempC) : null,
        minTempC: day ? Number(day.mintempC) : null,
        avgTempC: day ? Number(day.avgtempC) : null,
        condition: midday?.weatherDesc?.[0]?.value ?? null,
        chanceOfRainPct: midday?.chanceofrain !== undefined ? Number(midday.chanceofrain) : null,
        humidityPct: midday?.humidity !== undefined ? Number(midday.humidity) : null,
      },
    };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
