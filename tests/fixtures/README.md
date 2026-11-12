These fixtures contain only synthetic black frames generated locally with FFmpeg.

- `four-seconds.mp4`: four-second fragmented H.264 MP4 with a valid `ftyp` header. Used to reproduce a short fragment being mistaken for a complete lesson.
- `twelve-seconds.mp4`: twelve-second H.264 MP4.
- `lesson.m3u8` and `lesson-00.ts` through `lesson-02.ts`: the twelve-second video split into three four-second HLS segments.

They contain no course content. Tests use the bundled Mediabunny remuxer and do not require FFmpeg to be installed.

- `audio.m3u8` and `audio-*.ts`: twelve seconds of synthetic silent AAC audio.
- `master.m3u8`: pairs the synthetic video with the separate silent audio rendition to test HLS master selection and track pairing.

- `short-audio.mp4`: twelve seconds of synthetic video with only four seconds of silent AAC audio, to test incomplete sound rejection.
- `audio-short.m3u8`: a stale snapshot listing just the first audio segment.

- The separate audio HLS fixture starts at 2.336s (including AAC priming), matching the video's MPEG-TS presentation timeline at 2.4s. The original independent audio fixture started one second earlier; both renditions now share the proper timebase.
- `overlapping-gop.mp4`: a copy of the synthetic 12-second video whose fifth packet has a modified composition offset, making a new GOP start at 1.2999878s after the preceding GOP reached 1.5s. The previous bundled remuxer throws the same GOP ordering error reported by the user.
- `gop-master.m3u8`, `gop.m3u8`, and `gop-*.ts`: the same overlapping-GOP video as HLS, paired with the complete synthetic audio track. Used to check end-to-end remuxing and audio preservation with the upstream fix.
