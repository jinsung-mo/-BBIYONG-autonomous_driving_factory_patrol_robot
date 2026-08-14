package com.bbiyong.server.auth.security;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.assertj.core.api.Assertions.assertThat;

class RobotUploadTokenFilterTests {

    private static final String TOKEN = "robot-secret-123";
    private final RobotUploadTokenFilter filter = new RobotUploadTokenFilter(TOKEN);

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private Authentication runFilter(String servletPath, String headerToken) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", servletPath);
        req.setServletPath(servletPath);
        if (headerToken != null) {
            req.addHeader("X-Robot-Token", headerToken);
        }
        filter.doFilter(req, new MockHttpServletResponse(), new MockFilterChain());
        return SecurityContextHolder.getContext().getAuthentication();
    }

    @Test
    void validTokenOnUploadPathAuthenticatesAsRobot() throws Exception {
        Authentication auth = runFilter("/api/maps/upload", TOKEN);
        assertThat(auth).isNotNull();
        assertThat(auth.getAuthorities()).anyMatch(a -> a.getAuthority().equals("ROLE_ROBOT"));
    }

    @Test
    void validTokenOnVideoUploadPathAuthenticates() throws Exception {
        assertThat(runFilter("/api/videos/upload", TOKEN)).isNotNull();
    }

    @Test
    void invalidTokenDoesNotAuthenticate() throws Exception {
        assertThat(runFilter("/api/maps/upload", "wrong")).isNull();
    }

    @Test
    void missingTokenDoesNotAuthenticate() throws Exception {
        assertThat(runFilter("/api/maps/upload", null)).isNull();
    }

    @Test
    void validTokenOnNonUploadPathIsIgnored() throws Exception {
        assertThat(runFilter("/api/events", TOKEN)).isNull();
    }

    @Test
    void blankConfiguredTokenIsNoop() throws Exception {
        RobotUploadTokenFilter disabled = new RobotUploadTokenFilter("");
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/maps/upload");
        req.setServletPath("/api/maps/upload");
        req.addHeader("X-Robot-Token", "anything");
        disabled.doFilter(req, new MockHttpServletResponse(), new MockFilterChain());
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }
}
