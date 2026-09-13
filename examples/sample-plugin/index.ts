import { CamelCaseStep } from "./steps/camel-case-step.ts";
import { ConcatStringsStep } from "./steps/concat-strings-step.ts";
import { EchoStep } from "./steps/echo-step.ts";
import { GetWeatherStep } from "./steps/get-weather-step.ts";
import { ParseWeatherStep } from "./steps/parse-weather-step.ts";

export default function register(registry: import("@wfe/core").StepRegistry): void {
  registry.register({
    type: "sample.echo",
    version: "1.0.0",
    description: "Echoes its resolved inputs to outputs. Demo plugin.",
    factory: (params) => new EchoStep(params),
  });
  registry.register({
    type: "demo.concatStrings",
    version: "1.0.0",
    description: "Concatenates str1 and str2 with an optional delimiter.",
    factory: (params) => new ConcatStringsStep(params),
  });
  registry.register({
    type: "demo.camelCase",
    version: "1.0.0",
    description: "Converts the text input to camelCase.",
    factory: (params) => new CamelCaseStep(params),
  });
  registry.register({
    type: "demo.getWeather",
    version: "1.0.0",
    description: "Fetches wttr.in's JSON weather forecast for a city.",
    factory: (params) => new GetWeatherStep(params),
  });
  registry.register({
    type: "demo.parseWeather",
    version: "1.0.0",
    description: "Extracts a flat weather summary for a requested date from a wttr.in response.",
    factory: (params) => new ParseWeatherStep(params),
  });
}
