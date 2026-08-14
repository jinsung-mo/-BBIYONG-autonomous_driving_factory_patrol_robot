package com.bbiyong.server.map.service;

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
 * 2D 맵 이미지 파일의 로컬 파일시스템 저장·로드(MVP). VideoStorageService 와 동일 패턴.
 */
@Service
public class MapStorageService {

    private final Path baseDir;

    public MapStorageService(@Value("${bbiyong.map.storage-dir:map-store}") String storageDir) {
        this.baseDir = Paths.get(storageDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(baseDir);
        } catch (IOException e) {
            throw new IllegalStateException("맵 저장 디렉터리를 생성할 수 없습니다: " + baseDir, e);
        }
    }

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
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "맵 파일 저장에 실패했습니다.", e);
        }
        return baseDir.relativize(target).toString().replace('\\', '/');
    }

    /** 생성한 이미지 바이트를 저장하고 상대 경로를 반환한다(도면 산출물 등). */
    public String storeBytes(byte[] data, String prefix, String ext) {
        if (data == null || data.length == 0) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "저장할 데이터가 비어 있습니다.");
        }
        String suffix = (ext != null && ext.matches("\\.[A-Za-z0-9]{1,10}")) ? ext.toLowerCase() : "";
        String fileName = UUID.randomUUID() + suffix;
        Path dir = (prefix == null || prefix.isBlank()) ? baseDir : baseDir.resolve(sanitize(prefix));
        Path target = dir.resolve(fileName).normalize();
        if (!target.startsWith(baseDir)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 저장 경로입니다.");
        }
        try {
            Files.createDirectories(target.getParent());
            Files.write(target, data);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "도면 파일 저장에 실패했습니다.", e);
        }
        return baseDir.relativize(target).toString().replace('\\', '/');
    }

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

    public String probeContentType(Resource resource, String fallback) {
        try {
            String type = Files.probeContentType(resource.getFile().toPath());
            if (type != null) {
                return type;
            }
        } catch (IOException ignored) {
            // fall through
        }
        // ROS 원본 PGM 은 OS(Linux)의 probeContentType 이 인식하지 못하므로 확장자로 보정한다. (S15P11E101-616)
        String name = resource.getFilename();
        if (name != null && name.toLowerCase().endsWith(".pgm")) {
            return "image/x-portable-graymap";
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
        return ext.matches("\\.[A-Za-z0-9]{1,10}") ? ext.toLowerCase() : "";
    }

    private static String sanitize(String prefix) {
        return prefix.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
