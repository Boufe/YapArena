import type axe from "axe-core";
import type {} from "../frontend/site.ts";
import type {} from "../frontend/measurement.ts";
declare global {
  interface Window {
    axe: typeof axe;
    homeCsp: { directive: string; uri: string }[];
    __arenaMotion: { current: number; target: number }[];
    __arenaHeadingMotion: boolean;
    arenaSyntheticFrame: ReturnType<Window["setInterval"]>;
    arenaSyntheticVideo: HTMLVideoElement;
  }
}
