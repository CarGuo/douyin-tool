package io.github.carguo.douyintool.douyin

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity tests against the same fixtures used by the Node parser
 * (packages-server-test-fixtures-video.html / image.html).
 */
class DouyinParserTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun loadFixture(name: String): String {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/$name")
            ?: error("fixture not found: $name")
        return stream.bufferedReader().use { it.readText() }
    }

    @Test
    fun parsesVideoFixtureToVideoKindWithNoWatermarkUrl() {
        val html = loadFixture("video.html")
        val parsed = DouyinParser.parseHtml(html, json)
        assertNotNull("expected non-null parse result", parsed)
        parsed!!
        assertEquals(AwemeKind.VIDEO, parsed.kind)
        assertEquals("7300000000000000001", parsed.awemeId)
        assertEquals("测试视频 #fixture", parsed.desc)
        assertEquals("Fixture User", parsed.author.nickname)
        assertEquals("1234567890", parsed.author.uid)
        assertEquals("https://p3.douyinpic.com/cover/test.jpg", parsed.cover)

        val v = parsed.video
        assertNotNull(v)
        v!!
        // playwm in original
        assertTrue("playwm should appear in raw playUrl: ${v.playUrl}", v.playUrl.contains("playwm"))
        // and play in no-watermark variant
        assertTrue("playUrlNoWatermark should swap to /play/: ${v.playUrlNoWatermark}",
            v.playUrlNoWatermark.contains("/play/") || !v.playUrlNoWatermark.contains("playwm"))
        assertEquals(15000, v.duration)

        assertEquals("Original Sound", parsed.music?.title)
        assertEquals("Tester", parsed.music?.author)
        assertEquals(
            "https://sf3-cdn-tos.douyinstatic.com/obj/test-music.mp3",
            parsed.music?.playUrl,
        )
        assertNull(parsed.images)
    }

    @Test
    fun parsesImageFixtureToImageKindWithThreeImages() {
        val html = loadFixture("image.html")
        val parsed = DouyinParser.parseHtml(html, json)
        assertNotNull(parsed)
        parsed!!
        assertEquals(AwemeKind.IMAGE, parsed.kind)
        assertEquals("7300000000000000002", parsed.awemeId)
        val imgs = parsed.images
        assertNotNull(imgs)
        assertEquals(3, imgs!!.size)
        assertEquals("https://p3.douyinpic.com/img/1.jpeg", imgs[0].url)
        assertEquals(1080, imgs[0].width)
        assertEquals(1440, imgs[0].height)
        assertNull(parsed.video)
    }

    @Test
    fun toNoWatermarkConvertsBothPathSegmentAndBareWord() {
        // matches the Node parser behavior that double-replaces
        assertEquals(
            "https://aweme.snssdk.com/aweme/v1/play/?video_id=v0",
            DouyinParser.toNoWatermark("https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0"),
        )
        // bare-word fallback
        assertEquals(
            "https://x/y/play?z",
            DouyinParser.toNoWatermark("https://x/y/playwm?z"),
        )
    }

    @Test
    fun extractShareUrlFindsDouyinShareInsideMessyText() {
        val text = "7.99 复制打开抖音，看看 https://v.douyin.com/iABCDEF/ 转发给朋友"
        val u = UrlExtract.extractShareUrl(text)
        assertNotNull(u)
        assertTrue(u!!.startsWith("https://v.douyin.com/"))
    }

    @Test
    fun extractShareUrlReturnsNullForUnrelatedHost() {
        assertNull(UrlExtract.extractShareUrl("hello https://www.example.com/abc"))
    }

    @Test
    fun downloadHostAllowCoversBytedanceCdnFamilyIncludingBugAFix() {
        // primary
        assertTrue(DownloadHostAllow.isAllowed("v3-cold.douyinvod.com"))
        assertTrue(DownloadHostAllow.isAllowed("p3.douyinpic.com"))
        assertTrue(DownloadHostAllow.isAllowed("v3.byteimg.com"))

        // bug A: snssdk family
        assertTrue(DownloadHostAllow.isAllowed("aweme.snssdk.com"))
        assertTrue(DownloadHostAllow.isAllowed("api.aweme.snssdk.com"))
        assertTrue(DownloadHostAllow.isAllowed("snssdk.com"))

        // extras introduced with bug A fix
        assertTrue(DownloadHostAllow.isAllowed("v3.zjcdn.com"))
        assertTrue(DownloadHostAllow.isAllowed("foo.bytecdn.cn"))
        assertTrue(DownloadHostAllow.isAllowed("baz.pstatp.com"))

        // share-page hosts (also allowed via UrlExtract bridge)
        assertTrue(DownloadHostAllow.isAllowed("v.douyin.com"))
        assertTrue(DownloadHostAllow.isAllowed("www.douyin.com"))
        assertTrue(DownloadHostAllow.isAllowed("www.iesdouyin.com"))

        // negatives
        assertTrue(!DownloadHostAllow.isAllowed("evil.com"))
        assertTrue(!DownloadHostAllow.isAllowed("douyin.com.evil.com"))
    }
}
