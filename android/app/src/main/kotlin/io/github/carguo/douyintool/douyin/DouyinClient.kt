package io.github.carguo.douyintool.douyin

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Mirror of douyinClient.ts — fixed iPhone Safari UA so the share page
 * returns the mobile HTML that embeds _ROUTER_DATA cleanly.
 */
object DouyinClient {

    private const val IPHONE_UA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"

    fun build(timeoutMs: Long = 12_000): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    fun shareRequest(url: String): Request = Request.Builder()
        .url(url)
        .header("User-Agent", IPHONE_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .build()

    fun resolveShareUrl(client: OkHttpClient, url: String): String {
        val httpUrl = url.toHttpUrlOrNull() ?: return url
        if (httpUrl.host != "v.douyin.com") return url
        val noRedirect = client.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
        // HEAD first.
        try {
            val head = Request.Builder()
                .url(url)
                .head()
                .header("User-Agent", IPHONE_UA)
                .build()
            noRedirect.newCall(head).execute().use { res ->
                val loc = res.header("Location")
                if (!loc.isNullOrEmpty()) return loc
            }
        } catch (_: Throwable) {
            // ignore — fall through to GET
        }
        return try {
            noRedirect.newCall(shareRequest(url)).execute().use { res ->
                val loc = res.header("Location")
                if (!loc.isNullOrEmpty()) loc else url
            }
        } catch (_: Throwable) {
            url
        }
    }

    fun fetchSharePage(client: OkHttpClient, longUrl: String): String {
        client.newCall(shareRequest(longUrl)).execute().use { res ->
            if (!res.isSuccessful) throw IOException("share page status ${res.code}")
            val body = res.body ?: throw IOException("empty body")
            return body.string()
        }
    }
}
