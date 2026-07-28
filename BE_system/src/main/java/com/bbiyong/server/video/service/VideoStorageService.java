package com.bbiyong.server.video.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.UUID;

/**
 * 영상/썸네일 파일의 로컬 파일시스템 저장·로드(MVP). (설계 S15P11E101-329)
 *
 * <p>원본 바이트는 {@code bbiyong.video.storage-dir} 하위에 보관하고, DB(VideoClip)에는
 * baseDir 기준 상대 경로만 저장한다. S3 고도화 시 이 서비스만 교체하면 된다.
 */
@Service
public class VideoStorageService {

    private final Path baseDir;

    public VideoStorageService(@Value("${bbiyong.video.storage-dir:video-store}") String storageDir) {
        this.baseDir = Paths.get(storageDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(baseDir);
        } catch (IOException e) {
            throw new IllegalStateException("영상 저장 디렉터리를 생성할 수 없습니다: " + baseDir, e);
        }
    }

    /**
     * 업로드 파일을 {@code baseDir/prefix/<uuid><ext>} 로 저장하고 baseDir 기준 상대 경로를 반환한다.
     *
     * @param prefix 하위 분류 디렉터리(예: robotId). null/blank 이면 루트에 저장.
     */
    public String store(MultipartFile file, String prefix) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "업로드 파일이 비어 있습니다.");
        }
        String ext = extractExtension(file.getOriginalFilename());
        String fileName = UUID.randomUUID() + ext;
        Path dir = (prefix == null || prefix.isBlank()) ? baseDir : baseDir.resolve(sanitize(prefix));
        Path target = dir.resolve(fileName).normalize();
        if (!target.startsWith(baseDir)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 저장 경로입니다.");
        }
        try {
            Files.createDirectories(target.getParent());
            file.transferTo(target);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "영상 파일 저장에 실패했습니다.", e);
        }
        return baseDir.relativize(target).toString().replace('\\', '/');
    }

    /** 상대 경로의 파일을 읽기용 Resource 로 로드한다. 경로 이탈/부재 시 예외. */
    public Resource load(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "파일 경로가 없습니다.");
        }
        Path target = baseDir.resolve(relativePath).normalize();
        if (!target.startsWith(baseDir)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 파일 경로입니다.");
        }
        Resource resource = new FileSystemResource(target);
        if (!resource.exists() || !resource.isReadable()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "파일을 찾을 수 없습니다.");
        }
        return resource;
    }

    /** 파일 content-type 추론 (probe 실패 시 확장자 기반, 최종 fallback octet-stream). */
    public String probeContentType(Resource resource, String fallback) {
        try {
            String type = Files.probeContentType(resource.getFile().toPath());
            if (type != null) {
                return type;
            }
        } catch (IOException ignored) {
            // fall through
        }
        return fallback;
    }

    private static String extractExtension(String original) {
        if (original == null) {
            return "";
        }
        int dot = original.lastIndexOf('.');
        if (dot < 0 || dot == original.length() - 1) {
            return "";
        }
        String ext = original.substring(dot);
        // 확장자에 경로 구분자/공백이 섞이면 버린다.
        return ext.matches("\\.[A-Za-z0-9]{1,10}") ? ext.toLowerCase() : "";
    }

    private static String sanitize(String prefix) {
        // 경로 구분자 및 상위 이동 토큰 제거로 traversal 차단.
        return prefix.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
