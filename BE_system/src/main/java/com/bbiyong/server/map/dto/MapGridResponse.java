package com.bbiyong.server.map.dto;

import java.util.List;

/**
 * 관제 3D 압출(layer-stacking) 연출용 벽 격자 응답. (S15P11E101-728)
 *
 * <p>맵 이미지를 셀 단위로 다운샘플해 벽(어두운 픽셀) 여부를 이진 격자로 제공한다.
 * FE 는 캔버스 픽셀 판독 없이 이 격자를 그대로 아이소메트릭 압출 렌더링에 사용한다.
 * (프로토타입 docs/iso_map_extrude.html 의 buildMask 를 서버로 이전한 계약)
 *
 * @param mapId          원본 맵 아티팩트 ID
 * @param kind           원본 맵 종류 (RAW | FLOORPLAN)
 * @param cols           격자 가로 셀 수
 * @param rows           격자 세로 셀 수 (row 0 = 이미지 상단)
 * @param cellSizePx     셀 1칸이 커버하는 원본 픽셀 수
 * @param cellResolution 셀 1칸의 실측 크기(m). 원본 resolution(m/px) × cellSizePx. 메타 없으면 null
 * @param originX        ROS map 좌표계 origin (원본 승계, nullable)
 * @param originY        ROS map 좌표계 origin (원본 승계, nullable)
 * @param originYaw      ROS map 좌표계 origin yaw (원본 승계, nullable)
 * @param cells          row 별 '0'/'1' 문자열(위→아래). '1' = 벽
 */
public record MapGridResponse(
        String mapId,
        String kind,
        int cols,
        int rows,
        int cellSizePx,
        Double cellResolution,
        Double originX,
        Double originY,
        Double originYaw,
        List<String> cells
) {
}
