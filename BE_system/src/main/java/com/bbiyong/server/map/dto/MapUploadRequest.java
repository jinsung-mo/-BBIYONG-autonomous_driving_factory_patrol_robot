package com.bbiyong.server.map.dto;

/**
 * multipart 맵 업로드(POST /api/maps/upload)의 메타데이터 파트.
 * 이미지 바이트는 별도 file 파트로 전송된다.
 */
public record MapUploadRequest(
        String robotId,
        String name,
        Integer widthPx,
        Integer heightPx,
        Double resolution,   // meters per pixel
        Double originX,
        Double originY,
        Double originYaw
) {
}
