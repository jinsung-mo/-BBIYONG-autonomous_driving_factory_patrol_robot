package com.bbiyong.server.common;

import com.bbiyong.server.common.dto.ErrorResponse;
import com.bbiyong.server.common.exception.ProblemDetail;
import com.bbiyong.server.common.logging.LoggingContext;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * RFC 7807 Problem Details 표준을 따르는 전역 예외 처리기
 *
 * <p>모든 REST API 예외를 통일된 형식으로 응답합니다:</p>
 * <ul>
 *   <li>RFC 7807 표준 필드: type, title, status, detail, instance</li>
 *   <li>확장 필드: timestamp, requestId, errors (검증 에러)</li>
 * </ul>
 *
 * @see com.bbiyong.server.common.exception.ProblemDetail
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ProblemDetail> handleResponseStatus(ResponseStatusException ex, HttpServletRequest request) {
        HttpStatus status = HttpStatus.resolve(ex.getStatusCode().value());
        if (status == null) {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
        }

        ProblemDetail problem = buildProblem(
                status,
                status.getReasonPhrase(),
                ex.getReason() != null ? ex.getReason() : status.getReasonPhrase(),
                request.getRequestURI()
        );

        log.warn("ResponseStatusException: {} - {}", status, ex.getReason());
        return ResponseEntity.status(status).body(problem);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ProblemDetail> handleValidation(MethodArgumentNotValidException ex, HttpServletRequest request) {
        // 필드별 검증 에러 수집
        Map<String, String> fieldErrors = new LinkedHashMap<>();
        for (FieldError error : ex.getBindingResult().getFieldErrors()) {
            fieldErrors.put(error.getField(), error.getDefaultMessage());
        }

        ProblemDetail problem = ProblemDetail.builder()
                .type("/errors/validation-failed")
                .status(HttpStatus.BAD_REQUEST.value())
                .title("Validation Failed")
                .detail("요청 데이터의 유효성 검증에 실패했습니다.")
                .instance(request.getRequestURI())
                .errors(fieldErrors)
                .requestId(LoggingContext.getRequestId())
                .build();

        log.warn("Validation failed: {} errors at {}", fieldErrors.size(), request.getRequestURI());
        return ResponseEntity.badRequest().body(problem);
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ProblemDetail> handleMethodNotSupported(HttpRequestMethodNotSupportedException ex, HttpServletRequest request) {
        ProblemDetail problem = buildProblem(
                HttpStatus.METHOD_NOT_ALLOWED,
                "Method Not Allowed",
                "지원하지 않는 HTTP 메서드입니다: " + ex.getMethod(),
                request.getRequestURI()
        );
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(problem);
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ProblemDetail> handleMediaTypeNotSupported(HttpMediaTypeNotSupportedException ex, HttpServletRequest request) {
        ProblemDetail problem = buildProblem(
                HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                "Unsupported Media Type",
                "지원하지 않는 미디어 타입입니다. Content-Type을 확인해주세요.",
                request.getRequestURI()
        );
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(problem);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ProblemDetail> handleNoResource(NoResourceFoundException ex, HttpServletRequest request) {
        ProblemDetail problem = buildProblem(
                HttpStatus.NOT_FOUND,
                "Not Found",
                "요청한 리소스를 찾을 수 없습니다: " + request.getRequestURI(),
                request.getRequestURI()
        );
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem);
    }

    /**
     * 잘못된 파라미터/경로변수 타입, 누락된 필수 파라미터, 파싱 불가한 본문 → 400
     */
    @ExceptionHandler({
            MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class,
            HttpMessageNotReadableException.class
    })
    public ResponseEntity<ProblemDetail> handleBadRequest(Exception ex, HttpServletRequest request) {
        String detail = "유효하지 않은 요청입니다.";

        if (ex instanceof MissingServletRequestParameterException missEx) {
            detail = "필수 파라미터가 누락되었습니다: " + missEx.getParameterName();
        } else if (ex instanceof MethodArgumentTypeMismatchException typeEx) {
            detail = "파라미터 타입이 올바르지 않습니다: " + typeEx.getName();
        } else if (ex instanceof HttpMessageNotReadableException) {
            detail = "요청 본문을 파싱할 수 없습니다. JSON 형식을 확인해주세요.";
        }

        ProblemDetail problem = buildProblem(
                HttpStatus.BAD_REQUEST,
                "Bad Request",
                detail,
                request.getRequestURI()
        );
        return ResponseEntity.badRequest().body(problem);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ProblemDetail> handleGeneric(Exception ex, HttpServletRequest request) {
        log.error("Unhandled exception at {} : {}", request.getRequestURI(), ex.toString(), ex);

        ProblemDetail problem = buildProblem(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "Internal Server Error",
                "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
                request.getRequestURI()
        );
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(problem);
    }

    /**
     * RFC 7807 ProblemDetail 응답 생성 헬퍼
     */
    private ProblemDetail buildProblem(HttpStatus status, String title, String detail, String instance) {
        return ProblemDetail.builder()
                .type("about:blank")
                .status(status.value())
                .title(title)
                .detail(detail)
                .instance(instance)
                .requestId(LoggingContext.getRequestId())
                .build();
    }

    /**
     * 레거시 ErrorResponse 지원 (하위 호환성)
     * @deprecated RFC 7807 ProblemDetail 사용 권장
     */
    @Deprecated(since = "2026-08", forRemoval = true)
    private ResponseEntity<ErrorResponse> build(HttpStatusCode statusCode, String message, HttpServletRequest request) {
        int status = statusCode.value();
        HttpStatus resolved = HttpStatus.resolve(status);
        String error = resolved != null ? resolved.getReasonPhrase() : "Error";
        ErrorResponse body = new ErrorResponse(
                Instant.now().toString(),
                status,
                error,
                message != null ? message : error,
                request.getRequestURI()
        );
        return ResponseEntity.status(status).body(body);
    }
}
