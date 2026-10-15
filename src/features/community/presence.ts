// Ephemeral playback connections, not people/adoption measurement. Bounded to the
// existing single-instance staging topology; nothing is written to product metrics.
export function createPlaybackPresence({
  now = Date.now,
  ttl = 65000,
  maximum = 5000,
} = {}) {
  const connections = new Map<string, { event: string; seen: number }>();
  return {
    heartbeat(event: string, connection: string, active: boolean) {
      const at = now();
      for (const [id, item] of connections) {
        if (item.seen + ttl <= at) connections.delete(id);
      }
      const id = `${event}:${connection}`;
      if (!active) connections.delete(id);
      else if (connections.has(id) || connections.size < maximum)
        connections.set(id, { event, seen: at });
      return {
        activePlaybackTabs: [...connections.values()].filter(
          (item) => item.event === event,
        ).length,
        scope: "instance" as const,
        expiresAfterSeconds: Math.ceil(ttl / 1000),
      };
    },
  };
}
