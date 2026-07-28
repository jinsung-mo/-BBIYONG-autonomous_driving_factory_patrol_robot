package com.bbiyong.server;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = "spring.datasource.url=jdbc:sqlite:file:memdb_app?mode=memory&cache=shared")
class BbiyongServerApplicationTests {

	@Test
	void contextLoads() {
	}

}
