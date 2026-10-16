import type { PublicDebate, PublicTopic } from "./repository.ts";

export interface HomeDebate {
  id: string;
  kind: "live" | "replay";
  title: string;
  names: string[];
  meta: string;
  stamp: string;
  href: string | null;
}
export interface HomeIdea {
  id: string;
  cat: string;
  title: string;
  short: string;
  href: string | null;
  topicSlug: string | null;
  reference: boolean;
  demo: boolean;
  pct: number | null;
  delta: number | null;
  vol: number | null;
  people: number | null;
  price: number | null;
  points: number[];
  live: number;
  viewers: string | null;
  yes: string;
  no: string;
  arguments: { stance: string; text: string; rate: number | null }[];
  debates: HomeDebate[];
}
export interface HomeData {
  reference: boolean;
  available: boolean;
  ideas: HomeIdea[];
  following: string[];
}
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");

// Topic-level market/argument histories do not exist. A4 debate settlements are
// distinct from an ongoing idea market and are not silently relabeled as one.
export function publicHomepage(
  topics: PublicTopic[],
  playable: PublicDebate[],
): HomeData {
  return {
    reference: false,
    available: true,
    following: [],
    ideas: topics.map((topic) => {
      const debates: HomeDebate[] = playable
        .filter((debate) => debate.topic.slug === topic.slug)
        .map((debate) => {
          const a = debate.speakerA?.displayName ?? "Speaker A";
          const b = debate.speakerB?.displayName ?? "Speaker B";
          return {
            id: debate.id,
            kind: debate.status === "live" ? "live" : "replay",
            title: debate.proposition,
            names: [a, b, initials(a), initials(b)],
            meta: debate.status === "live" ? "Live debate" : "Recording ready",
            stamp: debate.status === "live" ? "Live" : "Replay",
            href: `/debates/${encodeURIComponent(debate.slug)}`,
          };
        });
      return {
        id: topic.id,
        topicSlug: topic.slug,
        href: `/topics/${encodeURIComponent(topic.slug)}`,
        cat: "Ideas",
        title: topic.title,
        short: topic.title,
        reference: false,
        demo: topic.isDemo,
        pct: null,
        delta: null,
        vol: null,
        people: null,
        price: null,
        points: [],
        viewers: null,
        live: debates.filter((debate) => debate.kind === "live").length,
        yes: topic.sideALabel,
        no: topic.sideBLabel,
        arguments: [
          { stance: "for", text: topic.sideALabel, rate: null },
          { stance: "against", text: topic.sideBLabel, rate: null },
        ],
        debates,
      };
    }),
  };
}
export const emptyIdea: HomeIdea = {
  id: "empty",
  cat: "Ideas",
  title: "The next idea is taking shape.",
  short: "Explore the arena",
  reference: false,
  demo: false,
  href: "/topics",
  topicSlug: null,
  pct: null,
  delta: null,
  vol: null,
  people: null,
  price: null,
  points: [],
  live: 0,
  viewers: null,
  yes: "Hear both sides.",
  no: "Discover a new perspective.",
  arguments: [],
  debates: [],
};
