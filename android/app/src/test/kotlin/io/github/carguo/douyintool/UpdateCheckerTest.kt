package io.github.carguo.douyintool

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {

    @Test fun newer_basic_patch() {
        assertTrue(UpdateChecker.isNewer("1.0.1", "1.0.0"))
    }

    @Test fun newer_minor_bump() {
        assertTrue(UpdateChecker.isNewer("1.1.0", "1.0.99"))
    }

    @Test fun newer_major_bump() {
        assertTrue(UpdateChecker.isNewer("2.0.0", "1.99.99"))
    }

    @Test fun strips_v_prefix() {
        assertTrue(UpdateChecker.isNewer("v1.2.0", "1.1.9"))
        assertTrue(UpdateChecker.isNewer("V1.2.0", "v1.1.9"))
    }

    @Test fun equal_versions_not_newer() {
        assertFalse(UpdateChecker.isNewer("1.0.0", "1.0.0"))
        assertFalse(UpdateChecker.isNewer("v1.0.0", "1.0.0"))
    }

    @Test fun older_not_newer() {
        assertFalse(UpdateChecker.isNewer("1.0.0", "1.0.1"))
        assertFalse(UpdateChecker.isNewer("v0.9.0", "1.0.0"))
    }

    @Test fun handles_extra_segment() {
        assertTrue(UpdateChecker.isNewer("1.0.0.1", "1.0.0"))
        assertFalse(UpdateChecker.isNewer("1.0.0", "1.0.0.1"))
    }

    @Test fun handles_short_segment() {
        assertTrue(UpdateChecker.isNewer("2.0", "1.99.99"))
        assertFalse(UpdateChecker.isNewer("1", "1.0.0"))
    }

    @Test fun strips_rc_suffix() {
        // "1.1.0-rc1" parses as 1.1.0, equal to "1.1.0" -> not newer.
        assertFalse(UpdateChecker.isNewer("1.1.0-rc1", "1.1.0"))
        assertTrue(UpdateChecker.isNewer("1.1.0-rc1", "1.0.99"))
    }

    @Test fun garbage_input_falls_back_to_zero() {
        assertFalse(UpdateChecker.isNewer("garbage", "1.0.0"))
        assertTrue(UpdateChecker.isNewer("1.0.0", "garbage"))
    }
}
