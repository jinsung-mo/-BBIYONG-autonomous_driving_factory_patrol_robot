package com.bbiyong.server.common.exception;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;
import java.util.Map;

/**
 * RFC 7807 Problem Details for HTTP APIs 표준 에러 응답
 *
 * <p>표준 필드:</p>
 * <ul>
 *   <li>type: 에러 타입 URI (예: /errors/validation-failed)</li>
 *   <li>title: 에러 제목 (간단한 설명)</li>
 *   <li>status: HTTP 상태 코드</li>
 *   <li>detail: 상세 에러 메시지</li>
 *   <li>instance: 에러가 발생한 요청 경로</li>
 * </ul>
 *
 * <p>확장 필드:</p>
 * <ul>
 *   <li>timestamp: 에러 발생 시각</li>
 *   <li>errors: 필드별 검증 에러 상세 (선택)</li>
 * </ul>
 *
 * @see <a href="https://datatracker.ietf.org/doc/html/rfc7807">RFC 7807</a>
 */
@Getter
@Builder
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ProblemDetail {

    /**
     * 에러 타입을 식별하는 URI
     * 예: "about:blank" (기본값), "/errors/validation-failed", "/errors/not-found"
     */
    @JsonProperty("type")
    private final String type;

    /**
     * 에러에 대한 간단한 설명 (사람이 읽을 수 있는 형태)
     */
    @JsonProperty("title")
    private final String title;

    /**
     * HTTP 상태 코드
     */
    @JsonProperty("status")
    private final int status;

    /**
     * 상세 에러 메시지 (이 에러 발생 건에 특화된 설명)
     */
    @JsonProperty("detail")
    private final String detail;

    /**
     * 에러가 발생한 요청 경로
     * 예: "/api/robots/123"
     */
    @JsonProperty("instance")
    private final String instance;

    /**
     * 에러 발생 시각 (ISO 8601 형식)
     */
    @JsonProperty("timestamp")
    @Builder.Default
    private final Instant timestamp = Instant.now();

    /**
     * 필드별 검증 에러 상세 정보 (Validation 에러 시)
     * Key: 필드명, Value: 에러 메시지
     */
    @JsonProperty("errors")
    private final Map<String, String> errors;

    /**
     * 요청 추적 ID (디버깅용)
     */
    @JsonProperty("requestId")
    private final String requestId;

    /**
     * 기본 ProblemDetail 생성 (about:blank 타입)
     */
    public static ProblemDetail of(int status, String title, String detail, String instance) {
        return ProblemDetail.builder()
                .type("about:blank")
                .status(status)
                .title(title)
                .detail(detail)
                .instance(instance)
                .build();
    }

    /**
     * 타입 URI를 명시한 ProblemDetail 생성
     */
    public static ProblemDetail of(String type, int status, String title, String detail, String instance) {
        return ProblemDetail.builder()
                .type(type)
                .status(status)
                .title(title)
                .detail(detail)
                .instance(instance)
                .build();
    }
}
