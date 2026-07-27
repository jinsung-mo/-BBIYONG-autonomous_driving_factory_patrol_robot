package com.bbiyong.server.common;

import com.bbiyong.server.common.dto.ErrorResponse;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;

/**
 * 모든 REST 예외를 명세 1.0 통일 포맷({timestamp, status, error, message, path})으로 응답한다.
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ErrorResponse> handleResponseStatus(ResponseStatusException ex, HttpServletRequest request) {
        return build(ex.getStatusCode(), ex.getReason(), request);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex, HttpServletRequest request) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                .orElse("유효하지 않은 입력값입니다.");
        return build(HttpStatus.BAD_REQUEST, message, request);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleGeneric(Exception ex, HttpServletRequest request) {
        log.error("Unhandled exception at {} : {}", request.getRequestURI(), ex.toString(), ex);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "서버 내부 오류가 발생했습니다.", request);
    }

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
