import { createWebServer, runWebServer } from "./web.ts";

await runWebServer(createWebServer(process.env));
