package com.bbiyong.server.video.service;

import com.bbiyong.server.video.domain.VideoClip;
import com.bbiyong.server.video.dto.VideoRegisterRequest;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.repository.VideoClipRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;

@Service
public class VideoService {

    private final VideoClipRepository videoClipRepository;

    public VideoService(VideoClipRepository videoClipRepository) {
        this.videoClipRepository = videoClipRepository;
    }

    @Transactional
    public VideoResponses.RegisterResult register(VideoRegisterRequest req) {
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

    @Transactional(readOnly = true)
    public VideoResponses.PageResult list(String robotId, String clipType, Instant from, Instant to, int page, int size) {
        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "startedAt"));
        return VideoResponses.PageResult.of(
                videoClipRepository.search(emptyToNull(robotId), emptyToNull(clipType), from, to, pageable));
    }

    @Transactional(readOnly = true)
    public VideoResponses.Detail getDetail(String id) {
        VideoClip clip = videoClipRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "영상 클립을 찾을 수 없습니다."));
        return VideoResponses.Detail.of(clip);
    }

    @Transactional(readOnly = true)
    public List<VideoResponses.Summary> getByEvent(Long eventId) {
        return videoClipRepository.findByEventIdOrderByStartedAtDesc(eventId)
                .stream().map(VideoResponses.Summary::of).toList();
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
