package com.bbiyong.server.video.service;

import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.video.domain.VideoClip;
import com.bbiyong.server.video.dto.VideoRegisterRequest;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.dto.VideoUploadRequest;
import com.bbiyong.server.video.repository.VideoClipRepository;
import org.springframework.core.io.Resource;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;

@Service
public class VideoService {

    private static final String STORAGE_FILESYSTEM = "FILESYSTEM";

    private final VideoClipRepository videoClipRepository;
    private final VideoStorageService storageService;
    private final EventLogRepository eventLogRepository;

    public VideoService(VideoClipRepository videoClipRepository, VideoStorageService storageService,
                        EventLogRepository eventLogRepository) {
        this.videoClipRepository = videoClipRepository;
        this.storageService = storageService;
        this.eventLogRepository = eventLogRepository;
    }

    /**
     * 클립이 가리키는 이벤트가 실제로 있는지 확인한다. video_clips.event_id 에는 외래키가 있어서
     * (V2 마이그레이션) 없는 이벤트를 가리키면 DB가 거절하는데, 그 경우 500 대신 400으로 알려 준다.
     */
    private void requireExistingEvent(Long eventId) {
        if (eventId != null && !eventLogRepository.existsById(eventId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "존재하지 않는 이벤트입니다: " + eventId);
        }
    }

    /** 외부(로봇/게이트웨이/S3)가 이미 저장을 마친 클립의 메타데이터만 등록한다. */
    @Transactional
    public VideoResponses.RegisterResult register(VideoRegisterRequest req) {
        requireExistingEvent(req.eventId());
        VideoClip clip = new VideoClip();
        clip.setRobotId(req.robotId());
        clip.setEventId(req.eventId());
        clip.setClipType(req.clipType());
        clip.setStorageType(req.storageType());
        clip.setFilePath(req.filePath());
        clip.setThumbnailPath(req.thumbnailPath());
        clip.setDurationSec(req.durationSec());
        clip.setFileSizeBytes(req.fileSizeBytes());
        clip.setStartedAt(req.startedAt());
        clip.setEndedAt(req.endedAt());
        clip.setCreatedAt(Instant.now());
        return VideoResponses.RegisterResult.of(videoClipRepository.save(clip));
    }

    /** 영상 파일 바이트를 서버 파일시스템에 저장하고 메타데이터를 함께 등록한다. */
    @Transactional
    public VideoResponses.RegisterResult registerUpload(VideoUploadRequest meta, MultipartFile file, MultipartFile thumbnail) {
        requireExistingEvent(meta.eventId());
        String storedPath = storageService.store(file, meta.robotId());
        String thumbnailPath = (thumbnail != null && !thumbnail.isEmpty())
                ? storageService.store(thumbnail, meta.robotId())
                : null;

        VideoClip clip = new VideoClip();
        clip.setRobotId(meta.robotId());
        clip.setEventId(meta.eventId());
        clip.setClipType(meta.clipType() != null && !meta.clipType().isBlank() ? meta.clipType() : "PATROL");
        clip.setStorageType(STORAGE_FILESYSTEM);
        clip.setFilePath(storedPath);
        clip.setThumbnailPath(thumbnailPath);
        clip.setDurationSec(meta.durationSec());
        clip.setFileSizeBytes(file.getSize());
        clip.setStartedAt(meta.startedAt() != null ? meta.startedAt() : Instant.now());
        clip.setEndedAt(meta.endedAt());
        clip.setCreatedAt(Instant.now());
        return VideoResponses.RegisterResult.of(videoClipRepository.save(clip));
    }

    @Transactional(readOnly = true)
    public VideoResponses.PageResult list(String robotId, String clipType, Instant from, Instant to, int page, int size) {
        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "startedAt"));
        return VideoResponses.PageResult.of(
                videoClipRepository.search(emptyToNull(robotId), emptyToNull(clipType), from, to, pageable));
    }

    @Transactional(readOnly = true)
    public VideoResponses.Detail getDetail(String id) {
        return VideoResponses.Detail.of(findClip(id));
    }

    @Transactional(readOnly = true)
    public List<VideoResponses.Summary> getByEvent(Long eventId) {
        return videoClipRepository.findByEventIdOrderByStartedAtDesc(eventId)
                .stream().map(VideoResponses.Summary::of).toList();
    }

    /** 재생 스트리밍용 영상 파일 로드. FILESYSTEM 저장분만 서빙 가능. */
    @Transactional(readOnly = true)
    public StoredFile loadVideo(String id) {
        VideoClip clip = findClip(id);
        if (!STORAGE_FILESYSTEM.equals(clip.getStorageType()) || clip.getFilePath() == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "서버에 저장된 재생 파일이 없습니다.");
        }
        Resource resource = storageService.load(clip.getFilePath());
        return new StoredFile(resource, storageService.probeContentType(resource, "video/mp4"));
    }

    /** 썸네일 이미지 파일 로드. */
    @Transactional(readOnly = true)
    public StoredFile loadThumbnail(String id) {
        VideoClip clip = findClip(id);
        if (!STORAGE_FILESYSTEM.equals(clip.getStorageType()) || clip.getThumbnailPath() == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "썸네일이 없습니다.");
        }
        Resource resource = storageService.load(clip.getThumbnailPath());
        return new StoredFile(resource, storageService.probeContentType(resource, "image/jpeg"));
    }

    private VideoClip findClip(String id) {
        return videoClipRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "영상 클립을 찾을 수 없습니다."));
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }

    /** 서빙용 파일 리소스 + content-type 묶음. */
    public record StoredFile(Resource resource, String contentType) {
    }
}
