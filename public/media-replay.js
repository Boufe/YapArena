export function createReplayPlayer({
  video,
  Hls,
  loadHls = async () => Hls,
  request,
  diagnostics,
  say,
  soundRequired,
  online = () => navigator.onLine,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let player;
  let grant;
  let renewing;
  let timer;
  let retryTimer;
  let generation = 0;
  let attempts = 0;
  let prepared = false;
  let loading = false;
  let wanted = false;
  let destroyed = false;
  let restore;
  let stableTimer;
  const snapshot = () => ({
    time: video.currentTime || 0,
    rate: video.playbackRate,
    paused: video.paused,
    captions: Array.from(video.textTracks).map((track) => track.mode),
  });
  function clearTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  async function play() {
    try {
      await video.play();
      soundRequired(false);
    } catch (error) {
      if (error.name === "NotAllowedError") {
        diagnostics.record("sound_activation_required");
        soundRequired(true);
      } else recover();
    }
  }
  function loaded() {
    if (!restore) return;
    video.currentTime = restore.time;
    video.playbackRate = restore.rate;
    Array.from(video.textTracks).forEach((track, i) => {
      track.mode = restore.captions[i] || "disabled";
    });
    const resume = !restore.paused;
    restore = undefined;
    loading = false;
    if (resume) void play();
  }
  video.addEventListener("loadedmetadata", loaded);
  const playing = () => {
    diagnostics.record("replay_resumed");
    if (stableTimer !== undefined) cancel(stableTimer);
    stableTimer = schedule(() => {
      attempts = 0;
      diagnostics.record("recovery_stable", { windowMs: 10_000 });
    }, 10_000);
  };
  const waiting = () => {
    if (stableTimer !== undefined) cancel(stableTimer);
    stableTimer = undefined;
  };
  video.addEventListener("playing", playing);
  video.addEventListener("waiting", waiting);
  video.addEventListener("error", recover);
  function renewLater() {
    clearTimer();
    timer = schedule(
      () => {
        timer = undefined;
        if (wanted && online()) void renew().catch(() => {});
      },
      Math.max(1000, (grant.expiresIn - 30) * 1000),
    );
  }
  async function load(access, previous, preload, epoch) {
    const PlaybackHls =
      access.type === "hls" &&
      !video.canPlayType("application/vnd.apple.mpegurl")
        ? await loadHls()
        : undefined;
    if (epoch !== generation || destroyed) return;
    if (PlaybackHls && !PlaybackHls.isSupported())
      throw new Error("Adaptive replay is not supported in this browser");
    player?.destroy();
    player = undefined;
    loading = true;
    restore = previous;
    grant = access;
    const captions = video.querySelector("track");
    if (captions)
      captions.src = access.captionsUrl || captions.dataset.originalSrc;
    video.preload = "metadata";
    video.crossOrigin = access.type === "hls" ? "anonymous" : null;
    if (PlaybackHls) {
      const Hls = PlaybackHls;
      player = new Hls({
        autoStartLoad: false,
        startLevel: 0,
        capLevelToPlayerSize: true,
        maxBufferLength: preload ? 2 : 15,
        maxMaxBufferLength: preload ? 4 : 30,
        maxBufferSize: preload ? 2_000_000 : 20_000_000,
        enableWorker: true,
      });
      const activePlayer = player;
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        if (player !== activePlayer) return;
        prepared = preload;
        // At most the first low rendition fragment is requested for preparation.
        player.startLoad(previous.time);
      });
      player.on(Hls.Events.FRAG_BUFFERED, () => {
        if (preload && !wanted && player === activePlayer) player.stopLoad();
      });
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (player === activePlayer && data.fatal) recover();
      });
      player.attachMedia(video);
      player.loadSource(access.url);
    } else {
      video.src = access.url;
      // Native preload=metadata is a browser hint; no initial-segment byte bound
      // can be guaranteed, so native preparation does not request autoplay.
      video.load();
      prepared = preload;
    }
    renewLater();
  }
  async function renew(preload = false) {
    if (renewing) return renewing;
    const epoch = generation;
    renewing = (async () => {
      try {
        const access = await request("/replay");
        if (destroyed || epoch !== generation) return;
        const previous = snapshot();
        if (wanted && !grant) previous.paused = false;
        diagnostics.record("authorization", { outcome: "allowed" });
        await load(access, previous, preload, epoch);
      } catch (error) {
        if (epoch !== generation || destroyed) return;
        diagnostics.record("authorization", {
          outcome: [401, 403, 404].includes(error.status)
            ? "denied"
            : "technical_error",
        });
        if ([401, 403, 404].includes(error.status)) {
          stop();
          diagnostics.finish("authorization_denied");
          say("Replay is no longer available.");
        } else recover();
        throw error;
      } finally {
        renewing = undefined;
      }
    })();
    return renewing;
  }
  function recover() {
    if (destroyed || !wanted || retryTimer !== undefined || !online()) return;
    if (attempts >= 5) {
      wanted = false;
      diagnostics.finish("technical_failure");
      say("Replay could not recover. Use Play replay to try again.");
      return;
    }
    const epoch = generation;
    diagnostics.record("replay_recovery");
    retryTimer = schedule(
      () => {
        retryTimer = undefined;
        if (epoch === generation && online()) void renew().catch(() => {});
      },
      Math.min(4000, 250 * 2 ** attempts++) * (0.75 + Math.random() * 0.5),
    );
  }
  function stop() {
    wanted = false;
    generation++;
    clearTimer();
    if (retryTimer !== undefined) cancel(retryTimer);
    retryTimer = undefined;
    waiting();
    player?.destroy();
    player = undefined;
    grant = undefined;
    prepared = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  return {
    async prepare() {
      if (!grant && !destroyed) await renew(true);
    },
    async start() {
      diagnostics.start("replay", prepared);
      wanted = true;
      attempts = 0;
      video.hidden = false;
      if (!grant) await renew();
      else {
        if (new Date(grant.expiresAt).getTime() <= Date.now() + 30_000)
          await renew();
        if (player) {
          player.config.maxBufferLength = 15;
          player.config.maxMaxBufferLength = 30;
          player.config.maxBufferSize = 20_000_000;
          player.startLoad(video.currentTime);
        }
        if (loading && restore) restore.paused = false;
      }
      if (wanted) await play();
    },
    async activateSound() {
      diagnostics.record("sound_activation_tap");
      video.muted = false;
      await play();
    },
    online() {
      if (wanted) void renew().catch(() => {});
    },
    offline() {
      clearTimer();
      if (retryTimer !== undefined) cancel(retryTimer);
      retryTimer = undefined;
      diagnostics.record("offline");
    },
    stop,
    destroy() {
      stop();
      destroyed = true;
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("playing", playing);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("error", recover);
    },
  };
}
