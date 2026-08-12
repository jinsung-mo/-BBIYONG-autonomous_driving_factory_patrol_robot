package com.bbiyong.server.video.service;

import com.bbiyong.server.video.dto.VideoRegisterRequest;
import com.bbiyong.server.video.event.EventClipRequestedEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * 위험 이벤트(화재·과열)의 사건 클립을 <b>이미 돌고 있는 HLS 세그먼트에서 잘라</b> 만든다.
 *
 * <h3>왜 이 방식인가 — 앞의 두 생산자가 모두 죽어 있다</h3>
 * 클립을 만들 수 있는 자리는 셋이었다.
 * <ol>
 *   <li><b>로봇이 녹화해 올린다</b>(원래 설계, S15P11E101-588). 서버는 지금도 저장 직후
 *       {@code EVENT_SAVED} 로 eventId 를 로봇에 회신한다({@code EventLogService}).
 *       그런데 로봇의 {@code event_clip_pipeline} 은 h264 인코더의 세그먼트에서 잘라내는데,
 *       2026-08-11 MJPEG 패스스루로 바뀌며 <b>입력이 끊겼다</b>. 코드는 멀쩡하지만 재료가 없다.</li>
 *   <li><b>서버가 VIDEO_FRAME 을 받아 자른다</b>(2026-08-12 결정). 전제는 프레임이 Spring 에
 *       도착하는 것이었는데, 그 뒤 영상이 HLS 로 우회해 로봇이
 *       {@code ORINCAR_VIDEO_TRANSPORT=off} 가 되었다. <b>서버는 프레임을 더 이상 보지 못한다.</b></li>
 *   <li><b>HLS 세그먼트에서 자른다</b>(이 클래스). 재료가 이미 디스크에 있다.</li>
 * </ol>
 *
 * <h3>왜 세그먼트를 신뢰할 수 있나 (2026-08-13 실측)</h3>
 * <ul>
 *   <li>{@code orincar-hls.service} 의 ffmpeg 이 2초 세그먼트를 계속 만든다({@code -hls_time 2}).</li>
 *   <li>🔑 {@code -hls_flags} 에 <b>{@code delete_segments} 가 없다.</b> 지우는 것은
 *       {@code orincar-hls-prune.timer}(5분 주기)뿐이고 <b>15분 롤링 보관</b>이다.
 *       즉 사건 시각의 과거 구간이 디스크에 남아 있어 자를 수 있다.</li>
 *   <li>로봇 시계와 AWS 시계 차이가 <b>1초 이내</b>다(동시 측정 1786548813 / 1786548812).
 *       그래서 로봇이 확정한 시각으로 세그먼트를 고를 수 있다.</li>
 * </ul>
 *
 * <h3>🔴 지연 실행이 본질이다</h3>
 * 이벤트가 확정된 <b>그 순간에는 사건 이후 구간의 세그먼트가 아직 존재하지 않는다.</b>
 * 즉시 자르면 뒤가 잘린 클립이 나온다. 그래서 {@code post + SEGMENT_SLACK} 만큼 기다린 뒤 자른다.
 * 이것이 이 클래스가 스케줄러를 갖는 유일한 이유다.
 */
@Slf4j
@Service
public class EventClipService {

    /**
     * 사건 이후 구간을 담기 위해 추가로 기다리는 초. 세그먼트 길이(2초)보다 넉넉해야 한다 —
     * 사건이 세그먼트 중간에 걸리면 그 세그먼트는 최대 2초 뒤에야 닫히고, ffmpeg 이
     * {@code temp_file} 로 쓰고 rename 하는 시간도 있다.
     */
    private static final long SEGMENT_SLACK_SEC = 4;

    /** 세그먼트 1개의 공칭 길이(초). EXTINF 는 1.1~2.1 로 흔들리므로 고르기에는 넉넉한 값을 쓴다. */
    private static final double SEGMENT_NOMINAL_SEC = 2.5;

    /** ffmpeg 한 번에 허용하는 시간. 스트림 복사라 보통 수백 ms 다. 넘으면 죽인다. */
    private static final long FFMPEG_TIMEOUT_SEC = 60;

    private final VideoService videoService;
    private final VideoStorageService storageService;

    private final Path hlsDir;
    private final int preSeconds;
    private final int postSeconds;
    private final Set<String> enabledTypes;
    private final String ffmpeg;

    /**
     * 잘라내기 전용 단일 스레드. 공용 풀을 쓰지 않는 이유가 둘이다 —
     * ① 지연 대기(약 9초) 동안 풀 스레드를 붙잡으면 경보 처리와 경합한다.
     * ② 단일 스레드면 ffmpeg 프로세스가 동시에 여러 개 뜨지 않는다(클립은 드물다).
     */
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "event-clip-cutter");
        t.setDaemon(true);
        return t;
    });

    public EventClipService(
            VideoService videoService,
            VideoStorageService storageService,
            @Value("${bbiyong.video.hls-dir:/hls}") String hlsDir,
            @Value("${bbiyong.video.clip-pre-seconds:10}") int preSeconds,
            @Value("${bbiyong.video.clip-post-seconds:5}") int postSeconds,
            @Value("${bbiyong.video.clip-event-types:FIRE,OVERHEAT}") String clipEventTypes,
            @Value("${bbiyong.video.ffmpeg:ffmpeg}") String ffmpeg) {
        this.videoService = videoService;
        this.storageService = storageService;
        this.hlsDir = Paths.get(hlsDir).toAbsolutePath().normalize();
        this.preSeconds = preSeconds;
        this.postSeconds = postSeconds;
        this.enabledTypes = Arrays.stream(clipEventTypes.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(s -> s.toUpperCase(Locale.ROOT))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        this.ffmpeg = ffmpeg;
    }

    /**
     * 이벤트 저장 직후 호출된다. 여기서는 <b>예약만</b> 하고 즉시 반환한다 —
     * 이 리스너는 경보 처리 스레드에서 불리므로 여기서 기다리면 경보가 늦어진다.
     */
    @EventListener
    public void onEventClipRequested(EventClipRequestedEvent event) {
        if (event.getEventId() == null || event.getOccurredAt() == null) {
            return;
        }
        String type = event.getType() == null ? "" : event.getType().toUpperCase(Locale.ROOT);
        if (!enabledTypes.contains(type)) {
            return;
        }
        if (!Files.isDirectory(hlsDir)) {
            // 로컬 개발처럼 HLS 를 마운트하지 않은 환경. 조용히 넘어가지 않고 한 번은 알린다.
            log.warn("이벤트 클립을 건너뛴다 — HLS 디렉터리가 없다: {} (eventId={})", hlsDir, event.getEventId());
            return;
        }
        long delaySec = postSeconds + SEGMENT_SLACK_SEC;
        log.info("이벤트 클립 예약: eventId={}, type={}, {}초 뒤에 자른다", event.getEventId(), type, delaySec);
        scheduler.schedule(() -> safeCut(event), delaySec, TimeUnit.SECONDS);
    }

    /** 스케줄러 스레드가 예외로 죽지 않게 감싼다(죽으면 이후 모든 클립이 조용히 사라진다). */
    private void safeCut(EventClipRequestedEvent event) {
        try {
            cut(event);
        } catch (Exception e) {
            log.error("이벤트 클립 생성 실패: eventId={}", event.getEventId(), e);
        }
    }

    private void cut(EventClipRequestedEvent event) throws IOException, InterruptedException {
        Instant occurredAt = event.getOccurredAt();
        Instant from = occurredAt.minusSeconds(preSeconds);
        Instant to = occurredAt.plusSeconds(postSeconds);

        List<Path> segments = pickSegments(from, to);
        if (segments.isEmpty()) {
            // 세그먼트가 없는 경우가 실제로 있다 — 카메라·터널이 죽어 있었거나 prune 이
            // 이미 지웠거나(15분). 빈 클립을 등록하면 관제에 재생 안 되는 행이 남으므로 만들지 않는다.
            log.warn("이벤트 클립 생성 안 함 — 구간에 세그먼트가 없다: eventId={}, {} ~ {}",
                    event.getEventId(), from, to);
            return;
        }

        String clipId = UUID.randomUUID().toString();
        Path outDir = storageService.baseDir().resolve("events");
        Files.createDirectories(outDir);
        Path mp4 = outDir.resolve(clipId + ".mp4");
        Path jpg = outDir.resolve(clipId + ".jpg");
        Path listFile = Files.createTempFile("event-clip-", ".txt");

        try {
            // concat demuxer 입력 목록. 경로에 특수문자가 없어야 하므로(live123.ts) 그대로 쓴다.
            String list = segments.stream()
                    .map(p -> "file '" + p.toAbsolutePath() + "'")
                    .collect(Collectors.joining("\n"));
            Files.write(listFile, list.getBytes(StandardCharsets.UTF_8));

            // -c copy: 재인코딩하지 않는다. CPU 를 거의 쓰지 않고 화질 손실도 없다.
            // -an: HLS 입력에 오디오가 없다(ffmpeg 명령에 -c:v 만 있다).
            // +faststart: moov 를 앞으로 보내 관제가 다 받기 전에 재생을 시작할 수 있게 한다.
            run(List.of(ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "concat", "-safe", "0", "-i", listFile.toString(),
                    "-c", "copy", "-an", "-movflags", "+faststart", mp4.toString()));

            if (!Files.exists(mp4) || Files.size(mp4) == 0) {
                log.error("이벤트 클립 생성 실패 — 출력이 비었다: eventId={}", event.getEventId());
                Files.deleteIfExists(mp4);
                return;
            }

            // 썸네일. 실패해도 클립 자체는 등록한다 — 목록에 그림이 없는 것이 영상이 없는 것보다 낫다.
            String thumbRelative = null;
            try {
                run(List.of(ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                        "-i", mp4.toString(), "-frames:v", "1", "-q:v", "3", jpg.toString()));
                if (Files.exists(jpg) && Files.size(jpg) > 0) {
                    thumbRelative = "events/" + clipId + ".jpg";
                }
            } catch (Exception thumbFailure) {
                log.warn("이벤트 클립 썸네일 실패(클립은 등록한다): eventId={}", event.getEventId(), thumbFailure);
            }

            int durationSec = preSeconds + postSeconds;
            videoService.register(new VideoRegisterRequest(
                    event.getRobotId(),
                    event.getEventId(),
                    "EVENT",
                    "FILESYSTEM",
                    "events/" + clipId + ".mp4",
                    thumbRelative,
                    durationSec,
                    Files.size(mp4),
                    from,
                    to));

            log.info("이벤트 클립 등록: eventId={}, 세그먼트 {}개, {} bytes, {}",
                    event.getEventId(), segments.size(), Files.size(mp4), mp4.getFileName());
        } finally {
            Files.deleteIfExists(listFile);
        }
    }

    /**
     * 구간에 걸치는 세그먼트를 고른다.
     *
     * <p>🔑 기준은 <b>파일 mtime</b> 이다. ffmpeg 이 {@code temp_file} 로 쓰고 rename 하므로
     * mtime ≈ 그 세그먼트가 <b>닫힌 시각</b> = 세그먼트의 끝이다. 따라서 세그먼트가 덮는
     * 구간은 대략 {@code [mtime - 길이, mtime]} 이다.
     *
     * <p>파일명 순서(live9.ts, live10.ts …)로 정렬하면 사전순이라 뒤집힌다. mtime 으로 정렬한다.
     */
    private List<Path> pickSegments(Instant from, Instant to) throws IOException {
        Instant windowStart = from.minusMillis((long) (SEGMENT_NOMINAL_SEC * 1000));
        List<Path> picked = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(hlsDir, "*.ts")) {
            for (Path p : stream) {
                Instant closedAt = Files.getLastModifiedTime(p).toInstant();
                // 세그먼트가 닫힌 시각이 [from-길이, to+길이] 안이면 구간과 겹친다.
                if (!closedAt.isBefore(windowStart)
                        && !closedAt.isAfter(to.plusMillis((long) (SEGMENT_NOMINAL_SEC * 1000)))) {
                    picked.add(p);
                }
            }
        }
        picked.sort(Comparator.comparing(p -> {
            try {
                return Files.getLastModifiedTime(p).toInstant();
            } catch (IOException e) {
                return Instant.EPOCH;
            }
        }));
        return picked;
    }

    private void run(List<String> command) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output;
        try (var in = process.getInputStream()) {
            output = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        if (!process.waitFor(FFMPEG_TIMEOUT_SEC, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("ffmpeg 시간 초과(" + Duration.ofSeconds(FFMPEG_TIMEOUT_SEC) + "): " + command);
        }
        if (process.exitValue() != 0) {
            throw new IOException("ffmpeg 실패(exit=" + process.exitValue() + "): " + output.trim());
        }
    }
}
