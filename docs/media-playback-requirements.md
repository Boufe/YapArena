# Playback acceptance scope

Status: proposed product requirements, selected before implementation on 2026-10-06.
The user selected iPhone SE (2nd generation) and Pixel 4a as provisional oldest trial
devices. This is a test floor, not a demonstrated support promise. Record physical
model, OS, browser and player versions; test newer iPhones with Safari, Android with
Chrome, and desktop Safari, Chrome and Firefox, current and previous major versions
where available. Use Canadian and US viewers, two speakers and 100 concurrent viewers
per debate across five simultaneous debates (10 speakers, 500 viewers).

Normal network: download >=10 Mbps, upload >=5 Mbps, RTT <100 ms, loss <0.5%.
Report weak-network runs separately, including Wi-Fi/cellular switches, backgrounding
and outages of 1, 5, 30 and 90 seconds. Never pool them into normal-network acceptance.
Record load, deployed commit, geography, network measurements and actual software.

| Measure                                                                          | Proposed normal-profile target |
| -------------------------------------------------------------------------------- | ------------------------------ |
| Replay tap to first rendered video frame / first audio playback, separately      | Median <1 s, p95 <2 s          |
| Live viewer tap to first rendered video frame / first audio playback, separately | Median <1 s, p95 <2 s          |
| Capture to viewer playback live delay                                            | p95 <=500 ms                   |
| Replay buffering / active viewing time                                           | <0.5%                          |
| Fatal technical failures / eligible attempts                                     | <0.1%                          |
| Brief interruption: restoration to resumed playback                              | p95 <=3 s                      |
| Network change / full rejoin: restoration to resumed playback                    | p95 <=5 s                      |
| Foreground return with usable connectivity to resumed playback                   | p95 <=5 s                      |

Typical means median. Always report p95, p99, sample count and uncertainty, for cold
and prepared starts independently. Tap starts the clock before authorization, connection
and media loading. Browser-required sound activation is a separate event and interval;
do not silently remove it from the tap-to-audio distribution. Define eligibility before
trials: an authorized publicly available recording or live event with expected enabled
test audio/video. Count authorization refusals, abandonment and intentional pauses
separately. An enabled but silent source is not proven audio loss.

Measure live delay with timestamped synthetic camera images and audio markers on
synchronized source/viewer clocks. Retain clock offset and uncertainty (aim <=10 ms),
external playback observations and traces. RTT, received packets and decoder timestamps
alone do not establish capture-to-playback delay. Browser frame callbacks establish
rendered-video timing; advancing audible media elements are only an audio playback
proxy. Verify actual first sound with timestamped acoustic/loopback measurements on
physical devices. A missing callback or unsupported statistic is missing evidence.

Measure total interruption as well as restoration-to-resume. A resume must continue
for at least ten seconds without another unplanned stall. Count buffering episodes,
total buffering and longest episode; exclude deliberate pause, seek, backgrounded
playback and explicitly disabled tracks. Report recovery failures, not only successes.

Mux's [quality objectives](https://www.mux.com/articles/video-analytics-for-developers-guide)
inform the replay startup, buffering and failure objectives. Live joining and the
500 ms delay target are YapArena engineering decisions requiring validation. See
[LiveKit preparation](https://docs.livekit.io/reference/client-sdk-js/classes/Room.html#prepareConnection),
[connection recovery](https://docs.livekit.io/intro/basics/connect/),
[Mux preload guidance](https://www.mux.com/docs/guides/data-startup-time-metric),
and [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/).

Release requires lifecycle automation, physical-device and accessibility trials,
authenticated edge/browser seeking checks and sustained load in this envelope.
Tests and configuration do not prove the targets. Existing hosting, recording,
clock-worker ownership and financial gates remain in force.
